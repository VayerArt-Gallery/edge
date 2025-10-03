import { handleConnectSync } from "./connect/index";
import { handleShopifyCache } from "./shopify-cache-worker";
import { syncArtistCollections } from "./cron/artist-collections";
import { syncStyleCollections } from "./cron/style-collections";
import { syncThemeCollections } from "./cron/theme-collections";
import type { Env } from "../types/env";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Sanity Connect webhook
    if (pathname === "/api/connect/sync" && request.method === "POST") {
      return handleConnectSync(request, env, ctx);
    }

    // Shopify cache proxy
    if (pathname === "/api/shopify/graphql") {
      return handleShopifyCache(request, env, ctx);
    }

    // Manual collection sync
    if (pathname === "/api/internal/sync" && request.method === "POST") {
      if (!authorizeManualRun(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      ctx.waitUntil(
        Promise.all([
          syncArtistCollections(env),
          syncStyleCollections(env),
          syncThemeCollections(env),
        ]),
      );
      return new Response("Manual collection sync triggered.");
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    console.log(`cron trigger received (${event.cron})`);
    ctx.waitUntil(
      Promise.all([
        syncArtistCollections(env),
        syncStyleCollections(env),
        syncThemeCollections(env),
      ]),
    );
  },
};

function authorizeManualRun(request: Request, env: Env): boolean {
  const configuredSecret = env.MANUAL_ARTIST_CRON_SECRET?.trim();
  if (!configuredSecret) return false;
  const provided = request.headers.get("x-run-secret")?.trim();
  return provided === configuredSecret;
}
