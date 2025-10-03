import { handleConnectSync } from "./connect/index";
import { handleShopifyCache } from "./shopify-cache-worker";
import { syncArtistCollections } from "./cron/artist-collections";
import type { Env } from "../types/env";

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

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    console.log(`cron trigger received (${event.cron})`);
    ctx.waitUntil(syncArtistCollections(env));
  },
};
