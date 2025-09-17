import type { Env } from "../../types/env";
import { chunk, extractNumericId } from "../utils";

/**
 * Fetch the custom/artist metafield values for a set of product IDs using Shopify's nodes API.
 * Returns a map productId -> exact artist name.
 */
export async function fetchArtistMetafields(
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

  for (const group of chunk(ids, 50)) {
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
      // Skip this chunk; webhook will retry on future changes
    }
  }
  console.log(
    `artist-meta: resolved ${map.size}/${ids.length} (host=${env.SHOPIFY_STORE_DOMAIN})`,
  );
  return map;
}

