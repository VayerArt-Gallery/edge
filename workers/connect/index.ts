import { createClient } from "@sanity/client";
import type { Env } from "../index";

// ---- Types -----------------------------------------------------------------

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
    inventoryPolicy?: string;
    inventoryQuantity?: number;
    inventoryManagement?: string;
    image?: { src: string } | null;
    price?: string | number;
    product: {
      id: `gid://shopify/Product/${string}`;
      status: "active" | "archived" | "draft" | "unknown";
    };
    // Connect payloads sometimes use "value" (singular). We guard below.
    selectedOptions?: { name: string; values?: string; value?: string }[];
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

// ---- Type guards -----------------------------------------------------------

export const isProductSync = (p: ConnectPayload): p is PayloadProductsSync =>
  (p as any).products &&
  (p.action === "create" || p.action === "update" || p.action === "sync");

export const isProductDelete = (
  p: ConnectPayload,
): p is PayloadProductsDelete =>
  Array.isArray((p as any).productIds) && p.action === "delete";

// ---- Sanity client ---------------------------------------------------------

/**
 * Create a Sanity client bound to the worker environment.
 * Use a least-privilege token dedicated to sync operations only.
 */
function getSanityClient(env: Env) {
  return createClient({
    projectId: env.SANITY_PROJECT_ID,
    dataset: env.SANITY_DATASET,
    apiVersion: "2023-10-01",
    token: env.SANITY_SYNC_TOKEN,
    useCdn: false,
  });
}

// ---- Utils -----------------------------------------------------------------

/**
 * Small helper to return JSON with no-store caching semantics to avoid intermediary caching.
 */
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

/**
 * Extract the trailing numeric ID from a Shopify GID string.
 * Returns null if a numeric suffix is not present.
 */
function extractNumericId(gid: string) {
  const m = gid?.match(/(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Split an array into fixed-size chunks. The final chunk may be smaller.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Generate a URL-safe slug from a human string. This is used for document IDs
 * and does not alter the stored/visible artist name.
 */
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

function stableKeyFrom(str: string) {
  // Very small, deterministic hash for _key stability
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return `k${Math.abs(h)}`;
}

/**
 * Deterministic 14-digit numeric ID from an arbitrary string.
 *  - FNV-1a 64-bit over UTF-8
 *  - Maps uniformly to 1..99_999_999_999_999 (never all zeros)
 *  - Leading zeros allowed via padStart(14, "0")
 *  - Non-cryptographic
 */
function numericId14FromString(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let hash = 0xcbf29ce484222325n; // 64-bit FNV offset basis
  const FNV_PRIME = 0x00000100000001b3n; // 64-bit FNV prime

  for (let i = 0; i < bytes.length; i++) {
    // Non-null assertion is safe due to loop bounds and fixed-length TypedArray
    hash ^= BigInt(bytes[i]!);
    hash = (hash * FNV_PRIME) & 0xffffffffffffffffn; // wrap to 64 bits
  }

  // Use masked 64-bit value directly; map uniformly into 1..10^14-1
  const MASKED = hash & 0xffffffffffffffffn;
  const MOD = 99_999_999_999_999n; // 10^14 - 1
  const num = (MASKED % MOD) + 1n;
  return num.toString().padStart(14, "0");
}

/**
 * Constant-time string compare to avoid timing leaks on short secrets.
 */
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return res === 0;
}

// ---- Builders --------------------------------------------------------------

/**
 * Build the published product document skeleton to upsert into Sanity.
 */
function buildStoreProductDocument(p: ConnectProduct) {
  const pid = extractNumericId(p.id);
  if (pid == null) throw new Error(`Bad product GID: ${p.id}`);

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
        minVariantPrice:
          p.priceRange?.minVariantPrice !== undefined
            ? p.priceRange.minVariantPrice
            : undefined,
        maxVariantPrice:
          p.priceRange?.maxVariantPrice !== undefined
            ? p.priceRange.maxVariantPrice
            : undefined,
      },
      productType: p.productType ?? "",
      slug: { _type: "slug", current: p.handle },
      status: p.status,
      // TAGS AS ARRAY
      tags: Array.isArray(p.tags) ? p.tags : [],
      title: p.title,
      vendor: p.vendor ?? "",
      options: (p.options ?? []).map((o) => ({
        _key: stableKeyFrom(o.name || String(o.position ?? "")),
        _type: "option",
        name: o.name,
        values: Array.isArray(o.values) ? o.values : [],
      })),
      variants: (p.variants ?? []).map((v) => ({
        _type: "reference",
        _ref: `shopifyProductVariant-${extractNumericId(v.id)}`,
        _weak: true,
        _key: String(extractNumericId(v.id) ?? ""),
      })),
    },
  };
}

/**
 * Build product variant documents derived from a Shopify product.
 * Computes availability semantics in a way that tolerates untracked inventory.
 */
function buildVariantDocs(p: ConnectProduct) {
  const pid = extractNumericId(p.id)!;
  return (p.variants ?? []).map((v) => {
    const vid = extractNumericId(v.id);
    if (vid == null) throw new Error(`Bad variant GID: ${v.id}`);

    // For originals (1 of 1), treat availability as:
    // - active product AND (quantity > 0 OR policy CONTINUE)
    // - if inventory not tracked (inventoryManagement falsy), we *assume available*
    //   to cover the “forgot to set quantity=1” case
    const qty = Number(v.inventoryQuantity ?? 0);
    const policy = (v.inventoryPolicy ?? "DENY").toUpperCase();
    const management = (v.inventoryManagement ?? "").toUpperCase();
    const productStatus = v.product?.status ?? p.status ?? "unknown";

    const isAvailable =
      productStatus === "active" &&
      (management
        ? policy === "CONTINUE" || qty > 0
        : true); /* not tracked -> assume available */

    const opts = (v.selectedOptions ?? []).map(
      (o) => o.values ?? o.value ?? "",
    );
    const [option1, option2, option3] = [
      opts[0] ?? "",
      opts[1] ?? "",
      opts[2] ?? "",
    ];

    return {
      _id: `shopifyProductVariant-${vid}`,
      _type: "productVariant",
      // IMPORTANT: only set fields below in patches (never _id/_type)
      store: {
        id: vid,
        gid: v.id,
        createdAt: p.createdAt, // Connect rarely includes per-variant timestamps
        productId: pid,
        productGid: p.id,
        title: v.title,
        price: Number(v.price ?? 0),
        compareAtPrice:
          v.compareAtPrice !== undefined ? Number(v.compareAtPrice) : 0,
        previewImageUrl: v.image?.src ?? "",
        sku: v.sku ?? "",
        status: productStatus,
        inventory: {
          isAvailable,
          // When inventoryManagement is not set, keep as empty string to
          // reflect "not tracked" while preserving availability behavior.
          management: management || "",
          policy: policy || "DENY",
          quantity: qty,
        },
        option1,
        option2,
        option3,
      },
    };
  });
}

// ---- Persistence helpers ---------------------------------------------------
/**
 * Build the product patch body (shared between published and draft ids).
 */
function buildProductPatch(
  baseDoc: ReturnType<typeof buildStoreProductDocument>,
) {
  const body: Record<string, unknown> = { store: baseDoc.store };
  if ((baseDoc as any).artistName)
    body["artistName"] = (baseDoc as any).artistName;
  if ((baseDoc as any).artist) body["artist"] = (baseDoc as any).artist;
  return body;
}

/**
 * Upsert a single product and its variants into Sanity.
 * - Creates/patches published and existing draft product docs
 * - Ensures a stable artist reference using a slug-based _id
 * - Soft-deletes variants that no longer exist for this product
 */
async function commitUpsertsForProduct(
  env: Env,
  product: ConnectProduct,
  artistNameById: Map<number, string>,
  ensuredArtistIds: Set<string>,
) {
  const sanity = getSanityClient(env);
  const tx = sanity.transaction();

  const pid = extractNumericId(product.id)!;
  const baseDoc = buildStoreProductDocument(product);

  // ----- Artist enrichment (optional) -----
  const artistName = artistNameById.get(pid);
  if (artistName) {
    // The stored artist name must exactly match the metafield value.
    const slug = toSlug(artistName);
    // Robust, non-readable ID similar to Shopify numeric style (14 digits)
    const artistPubId = `artist-${numericId14FromString(artistName)}`;
    (baseDoc as any).artistName = artistName;
    // Avoid redundant writes: only createIfNotExists if we haven't ensured in this batch.
    if (!ensuredArtistIds.has(artistPubId)) {
      tx.createIfNotExists({
        _id: artistPubId,
        _type: "artist",
        name: artistName, // exact value from metafield
        slug: { _type: "slug", current: slug }, // slug is human-readable; ID is numeric-like
      });
      ensuredArtistIds.add(artistPubId);
    }
    (baseDoc as any).artist = {
      _type: "reference",
      _ref: artistPubId,
      _weak: true,
    };
  }

  // ----- Product (published) -----
  tx.createIfNotExists({ _id: baseDoc._id, _type: baseDoc._type });
  tx.patch(baseDoc._id, (p) => p.set(buildProductPatch(baseDoc)));

  // ----- Product (draft) if exists -----
  const draftId = `drafts.${baseDoc._id}`;
  const hasDraft: string[] = await sanity.fetch(`*[_id==$id]._id`, {
    id: draftId,
  });
  if (hasDraft.length) {
    tx.patch(draftId, (p) => p.set(buildProductPatch(baseDoc)));
  }

  // ----- Variants (published) -----
  const variantDocs = buildVariantDocs(product);

  // Create/update current variants
  for (const v of variantDocs) {
    tx.createIfNotExists({ _id: v._id, _type: v._type });
    tx.patch(v._id, (p) => p.set({ store: v.store }));
  }

  // Soft-delete variants that no longer exist for this product
  const currentIds = new Set(
    variantDocs.map((v) => Number(String(v.store.id))),
  );
  const existingVariantIds: { _id: string; id: number }[] = await sanity.fetch(
    `*[_type=="productVariant" && store.productId==$pid]{_id, "id": store.id}`,
    { pid },
  );
  const missing = existingVariantIds.filter((e) => !currentIds.has(e.id));
  for (const m of missing) {
    tx.patch(m._id, (p) => p.set({ "store.isDeleted": true }));
  }

  await tx.commit();
}

async function markProductsDeleted(env: Env, productIds: number[]) {
  if (!productIds.length) return;
  const sanity = getSanityClient(env);

  const ids = productIds.map((n) => `shopifyProduct-${n}`);
  const drafts = ids.map((id) => `drafts.${id}`);

  const existing: string[] = await sanity.fetch(`*[_id in $ids]._id`, {
    ids,
  });
  const existingDrafts: string[] = await sanity.fetch(`*[_id in $ids]._id`, {
    ids: drafts,
  });

  // Also mark their variants deleted
  const variantIds: string[] = await sanity.fetch(
    `*[_type=="productVariant" && store.productId in $pids]._id`,
    { pids: productIds },
  );

  if (!existing.length && !existingDrafts.length && !variantIds.length) return;

  const tx = sanity.transaction();
  for (const id of existing)
    tx.patch(id, (p) => p.set({ "store.isDeleted": true }));
  for (const id of existingDrafts)
    tx.patch(id, (p) => p.set({ "store.isDeleted": true }));
  for (const vid of variantIds)
    tx.patch(vid, (p) => p.set({ "store.isDeleted": true }));
  await tx.commit();
}

// ---- Shopify metafield fetch (artist) --------------------------------------

/**
 * Fetch the custom/artist metafield for a set of product IDs using Shopify's
 * GraphQL nodes API. Requests are chunked to keep payloads small and avoid
 * excessive round-trips. Returns a map of productId -> exact artist name.
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
    query($ids: [ID!]!) {
      nodes(ids: $ids) {
        id
        ... on Product {
          metafield(namespace: "custom", key: "artist") { value }
        }
      }
    }
  `;

  // Nodes accepts many IDs; keep chunks moderate to control response size.
  const groups = chunk(ids, 50);
  for (const group of groups) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort("timeout"), 4000);
      const resp = await fetch(endpoint, {
        method: "POST",
        redirect: "follow",
        headers: {
          "content-type": "application/json",
          "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_API_TOKEN,
        },
        body: JSON.stringify({
          query,
          variables: { ids: group.map((id) => `gid://shopify/Product/${id}`) },
        }),
        signal: ctrl.signal,
      });
      clearTimeout(t);

      if (!resp.ok) {
        const peek = (await resp.text()).slice(0, 180);
        console.warn("artist-meta: non-200", {
          status: resp.status,
          host: new URL(endpoint).host,
          count: group.length,
          peek,
        });
        continue;
      }

      const json = (await resp.json()) as {
        data?: {
          nodes?: Array<{
            id?: string;
            metafield?: { value?: string | null } | null;
          } | null>;
        };
      };
      const nodes = json.data?.nodes ?? [];
      for (const node of nodes) {
        if (!node?.id) continue;
        const pid = extractNumericId(node.id);
        const val = (node as any).metafield?.value?.trim();
        if (pid && val) map.set(pid, val);
      }
    } catch {
      // Skip this group; Connect will retry on future changes
    }
  }

  console.log(
    `artist-meta: resolved ${map.size}/${ids.length} (host=${env.SHOPIFY_STORE_DOMAIN})`,
  );
  return map;
}

/**
 * Run promise-returning tasks with a fixed concurrency to control resource usage.
 */
async function runWithConcurrency(
  tasks: Array<() => Promise<unknown>>,
  limit: number,
) {
  if (tasks.length === 0) return;
  let i = 0;
  const workers: Promise<void>[] = [];
  const run = async () => {
    while (true) {
      const idx = i++;
      if (idx >= tasks.length) break;
      const task = tasks[idx]!; // safe under loop bounds; satisfies noUncheckedIndexedAccess
      try {
        await task();
      } catch {
        // Errors are handled inside tasks; continue
      }
    }
  };
  const n = Math.min(limit, tasks.length);
  for (let k = 0; k < n; k++) workers.push(run());
  await Promise.all(workers);
}

// ---- HTTP handler ----------------------------------------------------------

export async function handleConnectSync(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
) {
  // Method guard
  if (request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }

  // Auth via URL secret (constant-time compare)
  const url = new URL(request.url);
  const provided = url.searchParams.get("secret") || "";
  const expected = env.CONNECT_SHARED_SECRET || "";
  if (!expected || !timingSafeEqual(provided, expected)) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Basic content-type validation
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return json({ error: "Unsupported content-type" }, 415);
  }

  // Optional size guard (~1.5MB). Validate against byte length, not char count.
  const MAX = 1_500_000;
  const len = Number(request.headers.get("content-length") || "0");
  if (len && len > MAX) return json({ error: "Payload too large" }, 413);

  let payload: ConnectPayload;
  try {
    const buf = await request.arrayBuffer();
    if (!len && buf.byteLength > MAX)
      return json({ error: "Payload too large" }, 413);
    const raw = new TextDecoder().decode(buf);
    payload = JSON.parse(raw) as ConnectPayload;
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Product create/update/sync
  if (isProductSync(payload)) {
    const prods = Array.isArray(payload.products) ? payload.products : [];
    if (prods.length === 0) return json({ message: "OK" });

    // Batch product IDs to keep runtime within Connect’s window
    const ids = prods.map((p) => extractNumericId(p.id)!).filter(Boolean);
    const productById = new Map<number, ConnectProduct>();
    for (const p of prods) {
      const id = extractNumericId(p.id);
      if (id != null) productById.set(id, p);
    }
    const batches = chunk(ids, 25);

    for (const batch of batches) {
      // Fetch artist metafields in one request per chunk using nodes()
      const meta = await fetchArtistMetafields(batch, env); // Map<number,string>

      // Pre-ensure unique artist documents to reduce redundant createIfNotExists writes.
      // This keeps a set of ensured IDs we can share with per-product upserts.
      const ensuredArtistIds = new Set<string>();
      const uniqueArtists: Array<{ _id: string; name: string; slug: string }> = [];
      for (const name of new Set(Array.from(meta.values()))) {
        const _id = `artist-${numericId14FromString(name)}`;
        const slug = toSlug(name);
        if (!ensuredArtistIds.has(_id)) {
          ensuredArtistIds.add(_id);
          uniqueArtists.push({ _id, name, slug });
        }
      }
      if (uniqueArtists.length) {
        const sanity = getSanityClient(env);
        const preTx = sanity.transaction();
        for (const a of uniqueArtists) {
          preTx.createIfNotExists({
            _id: a._id,
            _type: "artist",
            name: a.name,
            slug: { _type: "slug", current: a.slug },
          });
        }
        try {
          await preTx.commit();
        } catch {
          // If this pre-ensure fails, the per-product upserts still create lazily.
          ensuredArtistIds.clear();
        }
      }

      // Create per-product tasks to upsert with limited concurrency to avoid pressure.
      const tasks: Array<() => Promise<unknown>> = [];
      for (const pid of batch) {
        const p = productById.get(pid);
        if (!p) continue;
        tasks.push(async () => {
          try {
            await commitUpsertsForProduct(env, p, meta, ensuredArtistIds);
          } catch (e) {
            console.warn("commitUpsertsForProduct failed", {
              pid,
              err: String(e),
            });
          }
        });
      }

      // Run up to 3 concurrent upserts to balance latency and resource limits.
      await runWithConcurrency(tasks, 3);
    }

    return json({ message: "OK" });
  }

  // Product delete
  if (isProductDelete(payload)) {
    try {
      await markProductsDeleted(env, payload.productIds);
    } catch (e) {
      console.warn("markProductsDeleted failed", { err: String(e) });
    }
    return json({ message: "OK" });
  }

  // Other payloads (collections, etc.)
  return json({ message: "OK" });
}
