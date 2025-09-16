import { createClient } from "@sanity/client";
import type { Env } from "../index";

export type ConnectAction = "create" | "update" | "sync" | "delete";

export type ConnectProduct = {
  id: `gid://shopify/Product/${string}`;
  title: string;
  handle: string;
  descriptionHtml?: string;
  featuredImage?: { src: string } | null;
  options?: { name: string; position: number; values: string[] }[];
  priceRange?: { minVariantPrice?: number; maxVariantPrice?: number };
  productType?: string;
  tags?: string[];
  variants?: {
    id: `gid://shopify/ProductVariant/${string}`;
    title: string;
    compareAtPrice?: number;
    inventoryPolicy: string;
    inventoryQuantity: number;
    inventoryManagement: string;
    image?: { src: string } | null;
    price: string;
    product: {
      id: `gid://shopify/Product/${string}`;
      status: "active" | "archived" | "draft" | "unknown";
    };
    selectedOptions?: { name: string; values: string }[];
    sku?: string;
  }[];
  vendor?: string;
  status: "active" | "archived" | "draft" | "unknown";
  createdAt: string;
  publishedAt?: string;
  updatedAt: string;
};

export type PayloadProductsSync = {
  action: "create" | "update" | "sync";
  products: ConnectProduct[];
};
export type PayloadProductsDelete = { action: "delete"; productIds: number[] };
export type ConnectPayload = PayloadProductsSync | PayloadProductsDelete;

// Type guards for stricter narrowing:
export const isProductSync = (p: ConnectPayload): p is PayloadProductsSync =>
  (p as any).products &&
  (p.action === "create" || p.action === "update" || p.action === "sync");

export const isProductDelete = (
  p: ConnectPayload,
): p is PayloadProductsDelete =>
  Array.isArray((p as any).productIds) && p.action === "delete";

function getSanityClient(env: Env) {
  return createClient({
    projectId: env.SANITY_PROJECT_ID,
    dataset: env.SANITY_DATASET,
    apiVersion: "2023-10-01",
    token: env.SANITY_SYNC_TOKEN,
    useCdn: false,
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function extractNumericId(gid: string) {
  const m = gid?.match(/(\d+)$/);
  return m ? Number(m[1]) : null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toSlug(input: string) {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function normalizeName(input: string) {
  return input.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function buildStoreProductDocument(p: ConnectProduct) {
  const pid = extractNumericId(p.id)!;
  return {
    _id: `shopifyProduct-${pid}`,
    _type: "product",
    store: {
      id: pid,
      gid: p.id,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      isDeleted: false,
      descriptionHtml: p.descriptionHtml ?? "",
      previewImageUrl: p.featuredImage?.src ?? "",
      priceRange: {
        minVariantPrice: p.priceRange?.minVariantPrice ?? undefined,
        maxVariantPrice: p.priceRange?.maxVariantPrice ?? undefined,
      },
      productType: p.productType ?? "",
      slug: { _type: "slug", current: p.handle },
      status: p.status,
      tags: (p.tags ?? []).join(","),
      title: p.title,
      vendor: p.vendor ?? "",
      options: (p.options ?? []).map((o, idx) => ({
        _key: `${idx}-${o.name}`,
        _type: "option",
        name: o.name,
        values: o.values ?? [],
      })),
      variants: (p.variants ?? []).map((v) => ({
        _type: "reference",
        _ref: `shopifyProductVariant-${extractNumericId(v.id)}`,
        _weak: true,
        _key: extractNumericId(v.id)?.toString(),
      })),
    },
  };
}

function buildVariantDocuments(p: ConnectProduct) {
  const pid = extractNumericId(p.id)!;
  return (p.variants ?? []).map((v) => {
    const vid = extractNumericId(v.id)!;
    const inStock = v.inventoryManagement
      ? v.inventoryPolicy.toLowerCase() === "continue" ||
        (v.inventoryQuantity ?? 0) > 0
      : true;
    const optVals = (v.selectedOptions ?? []).map((o) => o.values);
    const [option1, option2, option3] = [
      optVals[0] ?? "",
      optVals[1] ?? "",
      optVals[2] ?? "",
    ];
    return {
      _id: `shopifyProductVariant-${vid}`,
      _type: "productVariant",
      store: {
        id: vid,
        gid: v.id,
        createdAt: p.createdAt, // variant.createdAt not present; acceptable
        productId: pid,
        productGid: p.id,
        title: v.title,
        price: Number(v.price ?? 0),
        compareAtPrice: Number(v.compareAtPrice ?? 0),
        previewImageUrl: v.image?.src ?? "",
        sku: v.sku ?? "",
        status: v.product.status,
        inventory: {
          isAvailable: inStock,
          management: v.inventoryManagement?.toUpperCase() || "SHOPIFY",
          policy: v.inventoryPolicy?.toUpperCase() || "DENY",
        },
        option1,
        option2,
        option3,
      },
    };
  });
}

async function commitUpserts(
  env: Env,
  products: ConnectProduct[],
  metaById: Map<number, string>,
) {
  const sanity = getSanityClient(env);

  // detect existing product drafts to mirror default behavior
  const productIds = products.map(
    (p) => `shopifyProduct-${extractNumericId(p.id)}`,
  );
  const draftIds = productIds.map((id) => `drafts.${id}`);
  const existingDrafts: string[] = await sanity.fetch(`*[_id in $ids]._id`, {
    ids: draftIds,
  });

  const tx = sanity.transaction();
  const artistCache = new Map<string, { _id: string }>(); // key: slug

  for (const p of products) {
    const pid = extractNumericId(p.id)!;
    const baseDoc = buildStoreProductDocument(p);

    // ----- Artist enrichment (only when metafield present) -----
    const rawName = metaById.get(pid);
    if (rawName) {
      const cleanName = normalizeName(rawName);
      const slug = toSlug(cleanName);
      const artistPubId = `artist-${slug}`;
      const cached = artistCache.get(slug);
      const existing =
        cached ?? (await findArtist(env, { slug, name: cleanName }));
      if (!cached && existing?._id) {
        artistCache.set(slug, { _id: existing._id });
      }

      // Always store the human-readable name too
      (baseDoc as any).artistName = cleanName;

      if (existing?._id) {
        // Reference the actual existing artist document (whatever its _id is)
        (baseDoc as any).artist = {
          _type: "reference",
          _ref: existing._id,
          _weak: true,
        };
      } else {
        // Create a published artist doc with a predictable id, then reference it
        tx.createIfNotExists({
          _id: artistPubId,
          _type: "artist",
          name: rawName,
          slug: { _type: "slug", current: slug },
        });
        (baseDoc as any).artist = {
          _type: "reference",
          _ref: artistPubId,
          _weak: true,
        };
      }
    }

    // ----- Product (published) -----
    tx.createIfNotExists({ _id: baseDoc._id, _type: baseDoc._type });
    tx.patch(baseDoc._id, (p) =>
      p.set({
        store: baseDoc.store,
        ...((baseDoc as any).artistName
          ? { artistName: (baseDoc as any).artistName }
          : {}),
        ...((baseDoc as any).artist ? { artist: (baseDoc as any).artist } : {}),
      }),
    );

    // ----- Product (draft) if exists -----
    const draftId = `drafts.${baseDoc._id}`;
    if (existingDrafts.includes(draftId)) {
      tx.patch(draftId, (p) =>
        p.set({
          store: baseDoc.store,
          ...((baseDoc as any).artistName
            ? { artistName: (baseDoc as any).artistName }
            : {}),
          ...((baseDoc as any).artist
            ? { artist: (baseDoc as any).artist }
            : {}),
          _id: draftId,
        }),
      );
    }

    // ----- Variants (published) -----
    const variantDocs = buildVariantDocuments(p);
    for (const v of variantDocs) {
      tx.createIfNotExists({ _id: v._id, _type: v._type });
      tx.patch(v._id, (p) => p.set(v));
    }
  }

  await tx.commit();
}

async function markProductsDeleted(env: Env, productIds: number[]) {
  const sanity = getSanityClient(env);
  // Patch only existing docs (avoid creating on delete)
  const ids = productIds.map((n) => `shopifyProduct-${n}`);
  const existing: string[] = await sanity.fetch(`*[_id in $ids]._id`, { ids });
  const drafts: string[] = await sanity.fetch(`*[_id in $ids]._id`, {
    ids: ids.map((id) => `drafts.${id}`),
  });

  const tx = sanity.transaction();
  for (const id of existing) {
    tx.patch(id, (p) => p.set({ "store.isDeleted": true }));
  }
  for (const id of drafts) {
    tx.patch(id, (p) => p.set({ "store.isDeleted": true }));
  }
  if (existing.length + drafts.length > 0) await tx.commit();
}

/**
 * Fetch `custom.artist` metafield for each product ID using a per-product GraphQL query.
 * Mirrors the GraphiQL call you confirmed works.
 * Uses modest concurrency to stay within the 10s custom sync window.
 */
async function fetchArtistMetafields(
  ids: number[],
  env: Env,
): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (!ids.length) return map;
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_ADMIN_API_TOKEN) {
    console.warn("artist-meta: missing SHOPIFY envs; skipping");
    return map;
  }
  const endpoint = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
  const query = `
    query($id: ID!) {
      product(id: $id) {
        id
        metafield(namespace: "custom", key: "artist") { value }
      }
    }
  `;

  // process in small groups to avoid timeouts
  const groups = chunk(ids, 8);
  for (const group of groups) {
    await Promise.all(
      group.map(async (id) => {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort("timeout"), 3500); // keep total < 10s
          const resp = await fetch(endpoint, {
            method: "POST",
            redirect: "follow",
            headers: {
              "content-type": "application/json",
              "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_API_TOKEN,
            },
            body: JSON.stringify({
              query,
              variables: { id: `gid://shopify/Product/${id}` },
            }),
            signal: ctrl.signal,
          });
          clearTimeout(t);

          if (!resp.ok) {
            const peek = (await resp.text()).slice(0, 180);
            console.warn("artist-meta: non-200", {
              status: resp.status,
              host: new URL(endpoint).host,
              id,
              peek,
            });
            return;
          }

          const json = (await resp.json()) as {
            data?: {
              product?: { metafield?: { value?: string | null } | null };
            };
          };

          const val = json.data?.product?.metafield?.value?.trim();
          if (val) map.set(id, val);
        } catch {
          // ignore this id; Connect will retry on future changes
        }
      }),
    );
  }

  console.log(
    `artist-meta: resolved ${map.size}/${ids.length} (host=${env.SHOPIFY_STORE_DOMAIN})`,
  );
  return map;
}

/**
 * Resolve an artist by slug first, falling back to case-insensitive name.
 */
async function findArtist(
  env: Env,
  { slug, name }: { slug: string; name: string },
) {
  const sanity = getSanityClient(env);
  const query = `*[_type=="artist" && (slug.current == $slug || lower(name) == lower($name))][0]{_id}`;
  const params = { slug, name };
  const result = await sanity.fetch<{ _id?: string } | null>(query, params);
  return result && result._id ? result : null;
}

export async function handleConnectSync(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
) {
  // ---- Auth via URL secret ----
  const url = new URL(request.url);
  const provided = url.searchParams.get("secret");
  if (!provided || provided !== env.CONNECT_SHARED_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  // ---- Basic validation ----
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "Unsupported content-type" }, 415);
  }

  let payload: ConnectPayload;
  try {
    payload = await request.json<ConnectPayload>();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // ---- Product create/update/sync (self-write to Sanity) ----
  if (
    "products" in payload &&
    (payload.action === "create" ||
      payload.action === "update" ||
      payload.action === "sync")
  ) {
    const prods = payload.products;
    if (!Array.isArray(prods) || prods.length === 0) {
      return json({ message: "OK" }, 200);
    }

    // Chunk by product IDs to stay well under 10s
    const ids = prods.map((p) => extractNumericId(p.id)!).filter(Boolean);
    const batches = chunk(ids, 25);

    for (const batch of batches) {
      // Get custom.artist metafields for this batch
      const meta = await fetchArtistMetafields(batch, env); // Map<number,string>
      const subset = prods.filter((p) =>
        batch.includes(extractNumericId(p.id)!),
      );

      // Upsert product + variant docs, and add artist fields if present
      await commitUpserts(env, subset, meta);
    }

    return json({ message: "OK" }, 200);
  }

  // ---- Product delete ----
  if ("productIds" in payload && payload.action === "delete") {
    await markProductsDeleted(env, payload.productIds);
    return json({ message: "OK" }, 200);
  }

  // ---- Other payloads (collections etc.) acknowledged for now ----
  return json({ message: "OK" }, 200);
}
