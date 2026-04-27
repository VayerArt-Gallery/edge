import type { Env } from "../../types/env";
import { chunk, extractNumericId, retryWithBackoff } from "../utils";

/**
 * Fetch the custom/artist metafield values for a set of product IDs using Shopify's nodes API.
 * Returns a map productId -> exact artist name.
 */
export type ProductMetafields = {
  artist?: string;
  artMovement?: string;
  theme?: string;
  medium?: string;
  dimensionsGlobal?: string;
  dimensionsUs?: string;
};

/**
 * Fetch multiple metafields for a set of product IDs using Shopify's nodes API.
 * Returns a map productId -> metafields object.
 */
export async function fetchProductMetafields(
  ids: number[],
  env: Env,
): Promise<Map<number, ProductMetafields>> {
  const map = new Map<number, ProductMetafields>();
  if (!ids.length) return map;
  if (!env.SHOPIFY_STORE_DOMAIN || !env.SHOPIFY_ADMIN_API_TOKEN) {
    console.warn("product-meta: missing SHOPIFY envs; skipping");
    return map;
  }
  const endpoint = `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`;
  const query = `
    query($ids: [ID!]!) {
      nodes(ids: $ids) {
        id
        ... on Product {
          artist: metafield(namespace: "custom", key: "artist") { value }
          artMovement: metafield(namespace: "shopify", key: "art-movement") {
            value
            references(first: 10) {
              nodes {
                ... on Metaobject {
                  id
                  handle
                  label: field(key: "label") { value }
                }
              }
            }
          }
          theme: metafield(namespace: "shopify", key: "theme") {
            value
            references(first: 10) {
              nodes {
                ... on Metaobject {
                  id
                  handle
                  label: field(key: "label") { value }
                }
              }
            }
          }
          medium: metafield(namespace: "custom", key: "medium") { value }
          dimensionsGlobal: metafield(namespace: "custom", key: "dimensions_global") { value }
          dimensionsUs: metafield(namespace: "custom", key: "dimensions_us") { value }
        }
      }
    }
  `;

  for (const group of chunk(ids, 50)) {
    try {
      const resp = await retryWithBackoff(
        async () => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort("timeout"), 4000);
          try {
            const response = await fetch(endpoint, {
              method: "POST",
              redirect: "follow",
              headers: {
                "content-type": "application/json",
                "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_API_TOKEN,
              },
              body: JSON.stringify({
                query,
                variables: {
                  ids: group.map((id) => `gid://shopify/Product/${id}`),
                },
              }),
              signal: ctrl.signal,
            });

            if (!response.ok) {
              const peek = (await response.text()).slice(0, 180);
              console.warn("product-meta: non-200", {
                status: response.status,
                host: new URL(endpoint).host,
                count: group.length,
                peek,
              });
              if (response.status === 429 || response.status >= 500) {
                throw new Error(
                  `Shopify metafields request failed with ${response.status}`,
                );
              }
            }

            return response;
          } finally {
            clearTimeout(t);
          }
        },
        {
          retries: 4,
          baseDelayMs: 300,
        },
      );

      if (!resp.ok) {
        continue;
      }
      type MetaobjectNode = {
        id?: string;
        handle?: string;
        label?: { value?: string | null } | null;
      };
      type ProductNode = {
        id?: string;
        artist?: { value?: string | null } | null;
        artMovement?: {
          value?: string | null;
          references?: { nodes?: Array<MetaobjectNode | null> } | null;
        } | null;
        theme?: {
          value?: string | null;
          references?: { nodes?: Array<MetaobjectNode | null> } | null;
        } | null;
        medium?: { value?: string | null } | null;
        dimensionsGlobal?: { value?: string | null } | null;
        dimensionsUs?: { value?: string | null } | null;
      };
      const json = (await resp.json()) as {
        data?: { nodes?: Array<ProductNode | null> };
      };
      const nodes: Array<ProductNode | null> = json.data?.nodes ?? [];
      for (const node of nodes) {
        if (!node?.id) continue;
        const pid = extractNumericId(node.id);
        if (!pid) continue;
        const mf: ProductMetafields = {};
        const get = (f?: { value?: string | null } | null) => f?.value?.trim();
        const artist = get(node.artist);
        const readRefs = (
          mf?: {
            value?: string | null;
            references?: { nodes?: Array<MetaobjectNode | null> } | null;
          } | null,
        ) => {
          const nodes = mf?.references?.nodes ?? [];
          const labels = nodes
            .map((m) => m?.label?.value?.trim() || m?.handle?.trim())
            .filter((s): s is string => Boolean(s && s.length > 0));
          // Only support a single value; prefer the first labeled reference.
          if (labels.length > 0) return labels[0]!;
          return mf?.value?.trim();
        };
        const artMovement = readRefs(node.artMovement);
        const theme = readRefs(node.theme);
        const medium = get(node.medium);
        const dimensionsGlobal = get(node.dimensionsGlobal);
        const dimensionsUs = get(node.dimensionsUs);
        if (artist) mf.artist = artist;
        if (artMovement) mf.artMovement = artMovement;
        if (theme) mf.theme = theme;
        if (medium) mf.medium = medium;
        if (dimensionsGlobal) mf.dimensionsGlobal = dimensionsGlobal;
        if (dimensionsUs) mf.dimensionsUs = dimensionsUs;
        if (Object.keys(mf).length > 0) map.set(pid, mf);
      }
    } catch (error) {
      console.warn("product-meta: chunk failed", {
        host: new URL(endpoint).host,
        count: group.length,
        ids: group,
        err: String(error),
      });
    }
  }
  console.log(
    `product-meta: resolved ${map.size}/${ids.length} (host=${env.SHOPIFY_STORE_DOMAIN})`,
  );
  return map;
}

/** Backwards compatibility wrapper to fetch only artist metafields. */
export async function fetchArtistMetafields(
  ids: number[],
  env: Env,
): Promise<Map<number, string>> {
  const res = await fetchProductMetafields(ids, env);
  const out = new Map<number, string>();
  for (const [k, v] of res.entries()) {
    if (v.artist) out.set(k, v.artist);
  }
  return out;
}
