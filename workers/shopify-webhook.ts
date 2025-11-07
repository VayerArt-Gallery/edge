import type { CheckoutSessionRecord } from "./checkout-session";
import type { Env } from "../types/env";

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

async function verifyShopifyRequest(
  rawBody: string,
  hmacHeader: string | null,
  secret: string | undefined,
): Promise<boolean> {
  if (!secret || !hmacHeader) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(rawBody),
  );

  const expectedBytes = Uint8Array.from(atob(hmacHeader), (char) =>
    char.charCodeAt(0),
  );
  const actualBytes = new Uint8Array(signature);

  return timingSafeEqual(expectedBytes, actualBytes);
}

interface ShopifyOrderWebhookPayload {
  checkout_token?: string | null;
  cart_token?: string | null;
}

export async function handleShopifyOrderWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await request.text();
  const valid = await verifyShopifyRequest(
    rawBody,
    request.headers.get("x-shopify-hmac-sha256"),
    env.SHOPIFY_WEBHOOK_SECRET,
  );

  if (!valid) {
    console.warn("[shopify-webhook] invalid signature");
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: ShopifyOrderWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as ShopifyOrderWebhookPayload;
  } catch (error) {
    console.error("[shopify-webhook] invalid JSON payload", error);
    return new Response("Bad Request", { status: 400 });
  }

  const checkoutToken = payload.checkout_token?.trim() ?? null;
  const cartToken = payload.cart_token?.trim() ?? null;

  if (!checkoutToken && !cartToken) {
    console.warn("[shopify-webhook] payload missing checkout and cart token");
    return new Response(null, { status: 204 });
  }

  let record: CheckoutSessionRecord | null = null;

  if (checkoutToken) {
    const stored = await env.CART_KV_BINDING.get(
      `checkout:token:${checkoutToken}`,
      "json",
    );
    record = stored as CheckoutSessionRecord | null;
  }

  if (!record && cartToken) {
    const stored = await env.CART_KV_BINDING.get(
      `checkout:cart-key:${cartToken}`,
      "json",
    );
    record = stored as CheckoutSessionRecord | null;
  }

  if (!record) {
    console.warn("[shopify-webhook] no checkout record found for payload", {
      checkoutToken,
      cartToken,
    });
    // Nothing to reconcile; acknowledge for idempotency
    return new Response(null, { status: 204 });
  }

  console.log('[shopify-webhook] matched checkout record', {
    clientId: record.clientId,
    checkoutToken,
    cartToken,
    source: checkoutToken ? 'checkout_token' : 'cart_token',
  });

  const completedAt = new Date().toISOString();
  const updatedRecord: CheckoutSessionRecord = {
    ...record,
    status: "completed",
    completedAt,
  };

  const ops: Promise<void>[] = [];

  if (record.checkoutToken) {
    ops.push(
      env.CART_KV_BINDING.delete(`checkout:token:${record.checkoutToken}`),
    );
  }

  if (record.cartKey) {
    ops.push(env.CART_KV_BINDING.delete(`checkout:cart-key:${record.cartKey}`));
  }

  ops.push(
    env.CART_KV_BINDING.put(
      `checkout:client:${record.clientId}`,
      JSON.stringify(updatedRecord),
      { expirationTtl: EXPIRATION_TTL_SECONDS },
    ),
  );

  try {
    await Promise.all(ops);
  } catch (error) {
    console.error("[shopify-webhook] failed to update records", error);
    return new Response("Internal Error", { status: 500 });
  }

  return new Response(null, { status: 204 });
}

const EXPIRATION_TTL_SECONDS = 60 * 60; // 1 hour for completion records
