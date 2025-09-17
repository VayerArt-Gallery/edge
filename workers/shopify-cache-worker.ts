import type { Env } from "../types/env";

export async function handleShopifyCache(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Only consider caching for POST + public query ops
  if (request.method !== "POST") return fetch(request);

  const cacheClass = (request.headers.get("X-Cache-Class") || "").toLowerCase();
  const opType = (request.headers.get("X-Op-Type") || "").toLowerCase();
  const opName = request.headers.get("X-Op-Name") || "";

  const isEligible =
    cacheClass === "public" &&
    opType === "query" &&
    opName.startsWith("Public_");

  // Fast bypass for non-eligible
  if (!isEligible) {
    // Ensure we never cache private/mutation responses
    const resp = await fetch(request);
    return withNoStore(resp, "BYPASS");
  }

  // Parse request body once to build cache key (safe even if origin also reads body)
  const bodyText = await request.clone().text();
  let variables: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(bodyText);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.variables &&
      typeof parsed.variables === "object"
    ) {
      variables = parsed.variables as Record<string, unknown>;
    }
  } catch {
    // If body isn't JSON, treat as bypass (shouldn't happen)
    const resp = await fetch(request);
    return withNoStore(resp, "BYPASS_BAD_BODY");
  }

  // Whitelist variable keys that affect the result
  const allowedKeys = [
    "handle",
    "id",
    "first",
    "last",
    "after",
    "before",
    "query",
    "sortKey",
    "reverse",
    "country",
    "language",
    "cursor",
  ] as const;
  const keyVars: Record<string, unknown> = {};
  for (const k of allowedKeys) if (k in variables) keyVars[k] = variables[k];

  const apiVersion = env.SHOPIFY_API_VERSION || "2025-07";
  const keyPayload = JSON.stringify({ opName, apiVersion, v: keyVars });
  const keyHash = await sha256Hex(keyPayload);

  // Build a GET cache key (method must be GET for caches.default)
  const url = new URL(request.url);
  const cacheUrl = new URL(url.toString());
  // Keep path stable and append a deterministic suffix segment
  cacheUrl.pathname = `${url.pathname}__cf/${apiVersion}/${opName}/${keyHash}`;

  // IMPORTANT: Don’t include cookies/auth headers in the cache key
  const cacheKey = new Request(cacheUrl.toString(), {
    method: "GET",
    headers: new Headers({
      Accept: "application/json",
      "Accept-Encoding": request.headers.get("Accept-Encoding") || "gzip",
    }),
  });

  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    return withCacheIndicators(cached, "HIT");
  }

  // MISS: fetch from origin
  const originRes = await fetch(request);

  // Only cache healthy JSON responses without Set-Cookie
  const ok = originRes.ok;
  const ct = originRes.headers.get("content-type") || "";
  const hasSetCookie = originRes.headers.has("set-cookie");

  if (!ok || !ct.includes("application/json") || hasSetCookie) {
    return withNoStore(originRes, "BYPASS_UNCACHABLE");
  }

  // Normalize headers and enforce SWR caching
  const ttl = parseInt(env.CACHE_TTL || "60", 10);
  const swr = parseInt(env.CACHE_SWR || "300", 10);

  const headers = new Headers(originRes.headers);
  headers.set(
    "Cache-Control",
    `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${swr}`,
  );
  headers.set("Vary", "Accept-Encoding");

  const resp = new Response(originRes.body, {
    status: originRes.status,
    headers,
  });

  // Store in cache asynchronously
  ctx.waitUntil(cache.put(cacheKey, resp.clone()));
  return withCacheIndicators(resp, "MISS");
}

async function sha256Hex(message: string): Promise<string> {
  const enc = new TextEncoder().encode(message);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function withCacheIndicators(
  resp: Response,
  status: "HIT" | "MISS" | "BYPASS" | string,
): Response {
  const h = new Headers(resp.headers);
  h.set("X-Worker-Cache", status);
  return new Response(resp.body, { status: resp.status, headers: h });
}

function withNoStore(resp: Response, reason: string): Response {
  const h = new Headers(resp.headers);
  h.set("Cache-Control", "no-store");
  h.set("Vary", "Accept-Encoding");
  h.set("X-Worker-Cache", reason);
  return new Response(resp.body, { status: resp.status, headers: h });
}
