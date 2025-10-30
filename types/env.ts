import type { KVNamespace } from '@cloudflare/workers-types'

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
  MANUAL_ARTIST_CRON_SECRET?: string;
  CART_KV_BINDING: KVNamespace;
}
