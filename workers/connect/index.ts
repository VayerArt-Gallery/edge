import type { Env } from "../index";

// Sanity Connect payload types
export type ConnectAction = "create" | "update" | "sync" | "delete";

export type ConnectProduct = {
  id: `gid://shopify/Product/${string}`;
  // Other fields exist but not needed here
};

export type ConnectCollection = {
  id: `gid://shopify/Collection/${string}`;
};

export type PayloadProductsSync = {
  action: "create" | "update" | "sync";
  products: ConnectProduct[];
};

export type PayloadProductsDelete = {
  action: "delete";
  productIds: number[];
};

export type PayloadCollectionsSync = {
  action: "create" | "update" | "sync";
  collections: ConnectCollection[];
};

export type PayloadCollectionsDelete = {
  action: "delete";
  collectionIds: number[];
};

export type ConnectPayload =
  | PayloadProductsSync
  | PayloadProductsDelete
  | PayloadCollectionsSync
  | PayloadCollectionsDelete;

// Type guards for stricter narrowing:
export const isProductSync = (p: ConnectPayload): p is PayloadProductsSync =>
  (p as any).products &&
  (p.action === "create" || p.action === "update" || p.action === "sync");

export const isProductDelete = (
  p: ConnectPayload,
): p is PayloadProductsDelete =>
  Array.isArray((p as any).productIds) && p.action === "delete";

export async function handleConnectSync(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
) {
  // Auth check
  const url = new URL(request.url);
  const provided = url.searchParams.get("secret");
  if (!provided || provided !== env.CONNECT_SHARED_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Request validation
  if (
    request.headers.get("content-type")?.includes("application/json") !== true
  ) {
    return json({ error: "Unsupported content-type" }, 415);
  }
  const payload = await request.json<ConnectPayload>();
  if (!payload?.action) return json({ error: "Invalid payload" }, 400);

  // We only handle product create/update/sync for now
  if (
    !("products" in payload) ||
    !["create", "update", "sync"].includes(payload.action)
  ) {
    // Acknowledge other events so Connect doesn’t retry
    return json([], 200);
  }

  // Extract product IDs & chunk for time safety
  // Sanity Connect allows 10s
  const gids = payload.products.map((p) => p.id);
  const productIds = gids.map(extractNumericId).filter(Boolean) as number[];
  const chunks = chunk(productIds, 25); // conservative chunk size for 10s budget

  const docs: any[] = [];
  for (const ids of chunks) {
    // Fetch metafields in batch
    const meta = await fetchArtistMetafields(ids, env);

    // For each product, normalize + resolve artist
    const resolutions = await Promise.all(
      ids.map(async (id) => {
        const rawName = meta.get(id) || ""; // may be empty/undefined
        if (!rawName) return null;

        const slug = toSlug(rawName);
        const artistId = `artist-${slug}`;

        // Resolve artist (slug → name fallback). Public dataset: CDN read.
        const existing = await findArtist(env, { slug, name: rawName });

        const docsForThisProduct: any[] = [];

        if (!existing) {
          // Draft artist: name/slug only
          docsForThisProduct.push({
            _id: artistId,
            _type: "artist",
            name: rawName,
            slug: { _type: "slug", current: slug },
          });
        }

        // Product upsert (minimal patch)
        docsForThisProduct.push({
          _id: `shopifyProduct-${id}`,
          _type: "product",
          artist: { _type: "reference", _ref: artistId, _weak: true },
          artistName: rawName,
        });

        return docsForThisProduct;
      }),
    );

    // Flatten, skip nulls
    for (const r of resolutions) if (r) docs.push(...r);
  }

  // Return docs to Connect to write
  return json(docs, 200);
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

/**
 * Batch fetch `custom.artist` metafield for product IDs.
 * Returns a Map<number, string> of productId → artistName (raw).
 */
async function fetchArtistMetafields(
  ids: number[],
  env: Env,
): Promise<Map<number, string>> {
  const endpoint = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
  const query = `
    query($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          metafield(namespace: "custom", key: "artist") { value }
        }
      }
    }
  `;
  const variables = {
    ids: ids.map((id) => `gid://shopify/Product/${id}`),
  };

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_API_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    // Fail soft: return empty map so we don’t block Connect; it’ll retry
    return new Map();
  }

  const json = (await resp.json()) as {
    data?: {
      nodes?: { id: string; metafield?: { value?: string | null } | null }[];
    };
    errors?: any;
  };

  const map = new Map<number, string>();
  json.data?.nodes?.forEach((n) => {
    const id = extractNumericId(n?.id as string);
    const raw = n?.metafield?.value?.trim();
    if (id && raw) map.set(id, raw);
  });
  return map;
}

/**
 * Resolve an artist by slug first, falling back to case-insensitive name.
 * Uses public-read CDN
 */
async function findArtist(
  env: Env,
  { slug, name }: { slug: string; name: string },
) {
  const base = `https://${env.SANITY_PROJECT_ID}.apicdn.sanity.io/v2023-10-01/data/query/${env.SANITY_DATASET}`;

  // Slug match
  const q1 = encodeURIComponent(
    `*[_type=="artist" && slug.current == $s][0]{_id}`,
  );
  let resp = await fetch(`${base}?query=${q1}&$s=${encodeURIComponent(slug)}`);
  if (resp.ok) {
    const { result } = (await resp.json()) as {
      result: { _id: string } | null;
    };
    if (result?._id) return result;
  }

  // Name match (case-insensitive)
  const q2 = encodeURIComponent(
    `*[_type=="artist" && lower(name) == lower($n)][0]{_id}`,
  );
  resp = await fetch(`${base}?query=${q2}&$n=${encodeURIComponent(name)}`);
  if (resp.ok) {
    const { result } = (await resp.json()) as {
      result: { _id: string } | null;
    };
    if (result?._id) return result;
  }

  return null;
}
