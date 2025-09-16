import { handleConnectSync } from "./connect/index";
import { handleShopifyCache } from "./shopify-cache-worker";

export interface Env {
  CONNECT_SHARED_SECRET: string;
  SHOPIFY_ADMIN_API_TOKEN: string;
  SHOPIFY_STORE_DOMAIN: string;
  SHOPIFY_API_VERSION: string;
  SANITY_PROJECT_ID: string;
  SANITY_DATASET: string;
  SANITY_SYNC_TOKEN: string;
  CACHE_TTL?: string;
  CACHE_SWR?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url);

    // Sanity Connect webhook
    if (pathname === "/api/connect/sync" && request.method === "POST") {
      return handleConnectSync(request, env, ctx);
    }

    // Shopify cache proxy
    if (pathname === "/api/shopify/graphql") {
      return handleShopifyCache(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
