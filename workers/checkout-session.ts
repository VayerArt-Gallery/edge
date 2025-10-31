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
  checkoutUrl: string;
  checkoutToken: string | null;
  storedAt: string;
  status: "pending" | "completed";
  completedAt?: string;
}

function extractCheckoutToken(checkoutUrl: string): string | null {
  try {
    const url = new URL(checkoutUrl);
    const segments = url.pathname.split("/").filter(Boolean);
    const checkoutIndex = segments.indexOf("c");
    if (checkoutIndex >= 0 && checkoutIndex + 1 < segments.length) {
      return segments[checkoutIndex + 1] ?? null;
    }

    // Storefront sometimes uses /checkouts/<token>
    if (segments[0] === "checkouts" && segments[1]) {
      return segments[1];
    }
  } catch (error) {
    console.warn("[checkout-session] failed to extract token", error);
  }
  return null;
}

function extractCartKey(cartId: string | null): string | null {
  if (!cartId) return null;
  const trimmed = cartId.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || null;
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

  const checkoutToken = extractCheckoutToken(checkoutUrl);
  const cartKey = extractCartKey(cartId);
  const storedAt = new Date().toISOString();
  const record: CheckoutSessionRecord = {
    clientId,
    cartId,
    cartKey,
    checkoutUrl,
    checkoutToken,
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

  if (checkoutToken) {
    operations.push(
      env.CART_KV_BINDING.put(
        `checkout:token:${checkoutToken}`,
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
