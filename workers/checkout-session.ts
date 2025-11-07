import type { Env } from "../types/env";

const EXPIRATION_TTL_SECONDS = 2 * 60 * 60; // 2 hours

interface CheckoutSessionPayload {
  clientId: string;
  cartId: string;
  checkoutUrl: string;
}

interface CheckoutSessionRecord {
  clientId: string;
  cartId: string;
  cartKey: string | null;
  cartToken: string | null;
  checkoutUrl: string;
  storedAt: string;
  status: "pending" | "completed";
  completedAt?: string;
}

function extractCartToken(checkoutUrl: string): string | null {
  try {
    const url = new URL(checkoutUrl);
    const segments = url.pathname.split("/").filter(Boolean);

    const candidateBuckets: string[] = [];

    const checkoutRootIndex = segments.indexOf("checkouts");
    if (checkoutRootIndex >= 0) {
      candidateBuckets.push(...segments.slice(checkoutRootIndex + 1));
    }

    const cartRootIndex = segments.indexOf("cart");
    if (cartRootIndex >= 0) {
      candidateBuckets.push(...segments.slice(cartRootIndex + 1));
    }

    if (candidateBuckets.length === 0) {
      return null;
    }

    const tokenCandidate = candidateBuckets.find((segment) =>
      /^[A-Za-z0-9_-]{8,}$/.test(segment),
    );

    if (tokenCandidate) {
      return tokenCandidate;
    }

    console.warn('[checkout-session] no valid token segment detected', {
      pathname: url.pathname,
      segments,
    });
    return candidateBuckets[0] ?? null;
  } catch (error) {
    console.warn("[checkout-session] failed to extract token", error);
  }
  return null;
}

function extractCartKey(cartId: string | null, checkoutUrl: string): string | null {
  const sources = [cartId, checkoutUrl];

  for (const source of sources) {
    if (!source) continue;
    const trimmed = source.trim();
    if (!trimmed) continue;

    const queryIndex = trimmed.indexOf('?');
    if (queryIndex >= 0) {
      const search = trimmed.slice(queryIndex + 1);
      const params = new URLSearchParams(search);
      const keyParam = params.get('key');
      if (keyParam) return keyParam;
    }
  }

  if (cartId) {
    const withoutQuery = cartId.split('?')[0] ?? cartId;
    const parts = withoutQuery.split('/');
    if (parts.length > 0) {
      return parts[parts.length - 1] ?? null;
    }
  }

  return null;
}

type RuntimeEnv = "development" | "production";

function resolveRuntimeEnv(env: Env): RuntimeEnv {
  return env.ENVIRONMENT === "development" ? "development" : "production";
}

function allowedOriginsFor(envType: RuntimeEnv): readonly string[] {
  if (envType === "development") {
    return ["http://localhost:3000"] as const;
  }
  return ["https://www.ag-gallery.com", "https://ag-gallery.com"] as const;
}

function resolveAllowedOrigin(
  envType: RuntimeEnv,
  origin: string | null,
): string | null {
  if (!origin) return null;
  const allowed = allowedOriginsFor(envType);
  return allowed.includes(origin) ? origin : null;
}

export async function handleCheckoutSession(
  request: Request,
  env: Env,
): Promise<Response> {
  const runtimeEnv = resolveRuntimeEnv(env);
  const origins = allowedOriginsFor(runtimeEnv);
  const originHeader = request.headers.get("Origin");
  const allowedOrigin = resolveAllowedOrigin(runtimeEnv, originHeader);
  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin ?? origins[0],
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  } as const;

  if (request.method === "OPTIONS") {
    if (!allowedOrigin) {
      return new Response("Forbidden", { status: 403 });
    }
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method === "GET") {
    if (!allowedOrigin && originHeader) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders });
    }
    return handleGetStatus(request, env, corsHeaders);
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: corsHeaders,
    });
  }

  if (originHeader && !allowedOrigin) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }

  let body: CheckoutSessionPayload | undefined;
  try {
    body = (await request.json()) as CheckoutSessionPayload;
  } catch (error) {
    console.error("[checkout-session] failed to parse body", error);
    return new Response("Invalid JSON", {
      status: 400,
      headers: corsHeaders,
    });
  }

  if (!body || typeof body !== "object") {
    return new Response("Invalid payload", {
      status: 400,
      headers: corsHeaders,
    });
  }

  const clientId = body.clientId?.trim();
  const cartId = body.cartId?.trim();
  const checkoutUrl = body.checkoutUrl?.trim();

  if (!clientId || !cartId || !checkoutUrl) {
    return new Response("Missing required fields", {
      status: 400,
      headers: corsHeaders,
    });
  }

  const cartToken = extractCartToken(checkoutUrl);
  const cartKey = extractCartKey(cartId, checkoutUrl);
  if (!cartToken) {
    console.warn('[checkout-session] missing cart token for url', checkoutUrl);
  }
  if (!cartKey) {
    console.warn('[checkout-session] missing cart key for id', cartId);
  }
  const storedAt = new Date().toISOString();
  const record: CheckoutSessionRecord = {
    clientId,
    cartId,
    cartKey,
    cartToken,
    checkoutUrl,
    storedAt,
    status: "pending",
  };

  const operations: Promise<void>[] = [];

  operations.push(
    env.CART_KV_BINDING.put(
      `checkout:client:${clientId}`,
      JSON.stringify(record),
      { expirationTtl: EXPIRATION_TTL_SECONDS },
    ),
  );

  if (cartKey) {
    operations.push(
      env.CART_KV_BINDING.put(
        `checkout:cart-key:${cartKey}`,
        JSON.stringify(record),
        { expirationTtl: EXPIRATION_TTL_SECONDS },
      ),
    );
  }

  if (cartToken) {
    operations.push(
      env.CART_KV_BINDING.put(
        `checkout:cart-token:${cartToken}`,
        JSON.stringify(record),
        { expirationTtl: EXPIRATION_TTL_SECONDS },
      ),
    );
  }

  try {
    await Promise.all(operations);
  } catch (error) {
    console.error("[checkout-session] failed to persist", error);
    return new Response("Failed to persist session", {
      status: 500,
      headers: corsHeaders,
    });
  }

  return new Response(null, { status: 204, headers: corsHeaders });
}

export type { CheckoutSessionRecord };

async function handleGetStatus(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("clientId")?.trim();

  if (!clientId) {
    return new Response("Missing clientId", {
      status: 400,
      headers: corsHeaders,
    });
  }

  let record: CheckoutSessionRecord | null = null;
  try {
    record = (await env.CART_KV_BINDING.get(
      `checkout:client:${clientId}`,
      "json",
    )) as CheckoutSessionRecord | null;
  } catch (error) {
    console.error("[checkout-session] failed to read status", error);
    return new Response("Failed to read status", {
      status: 500,
      headers: corsHeaders,
    });
  }

  if (!record) {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const body = JSON.stringify({
    status: record.status,
    checkoutUrl: record.checkoutUrl,
    cartId: record.cartId,
    completedAt: record.completedAt ?? null,
  });

  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}
