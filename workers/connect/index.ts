import type { Env } from "../../types/env";
import type { ConnectPayload, ConnectProduct } from "../../types/connect";
import { isProductDelete, isProductSync } from "../../types/connect";
import { fetchArtistMetafields } from "../../lib/shopify/metafields";
import { getSanityClient } from "../../lib/sanity/client";
import { commitUpsertsForProduct, markProductsDeleted } from "../../lib/sanity/persist";
import {
  json,
  timingSafeEqual,
  extractNumericId,
  chunk,
  toSlug,
  numericId14FromString,
  runWithConcurrency,
} from "../../lib/utils";

/**
 * Sanity Connect webhook handler for Shopify product sync events.
 * - Validates method, auth, content-type, and payload size (bytes)
 * - Fetches artist metafields via Shopify GraphQL nodes() in chunks
 * - Pre-ensures unique artist docs per batch to reduce redundant writes
 * - Upserts products/variants with limited concurrency
 * - Soft-deletes products/variants on delete payloads
 */
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
    if (!len && buf.byteLength > MAX) return json({ error: "Payload too large" }, 413);
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
            console.warn("commitUpsertsForProduct failed", { pid, err: String(e) });
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

