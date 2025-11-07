import { handleConnectSync } from "./connect/index";
import { handleShopifyCache } from "./shopify-cache-worker";
import { handleCheckoutSession } from "./checkout-session";
import { handleShopifyOrderWebhook } from "./shopify-webhook";
import { syncArtistCollections } from "./cron/artist-collections";
import { syncStyleCollections } from "./cron/style-collections";
import { syncThemeCollections } from "./cron/theme-collections";
import type { Env } from "../types/env";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const pathname = normalizePath(url.pathname);
    console.log('[edge] incoming request', {
      method: request.method,
      originalPath: url.pathname,
      normalizedPath: pathname,
    });

    // Sanity Connect webhook
    if (pathname === "/api/connect/sync" && request.method === "POST") {
      return handleConnectSync(request, env, ctx);
    }

    // Shopify cache proxy
    if (pathname === "/api/shopify/graphql") {
      return handleShopifyCache(request, env, ctx);
    }

    // Checkout session ingestion
    if (pathname === "/api/internal/checkout-session") {
      return handleCheckoutSession(request, env);
    }

    if (pathname === "/api/webhooks/shopify/orders") {
      if (request.method === "POST") {
        return handleShopifyOrderWebhook(request, env);
      }
      console.warn('[edge] unexpected method for shopify webhook', {
        method: request.method,
        pathname: url.pathname,
      });
      return new Response('Method not allowed', { status: 405 });
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

    console.warn('[edge] unhandled request', {
      method: request.method,
      pathname: url.pathname,
    });
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

function normalizePath(pathname: string): string {
  if (pathname === '/') return '/';
  return pathname.replace(/\/+$/u, '');
}

function authorizeManualRun(request: Request, env: Env): boolean {
  const configuredSecret = env.MANUAL_ARTIST_CRON_SECRET?.trim();
  if (!configuredSecret) return false;
  const provided = request.headers.get("x-run-secret")?.trim();
  return provided === configuredSecret;
}
