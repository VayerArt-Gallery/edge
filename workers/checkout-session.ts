import type { Env } from "../types/env";

const EXPIRATION_TTL_SECONDS = 2 * 60 * 60; // 2 hours

interface CheckoutSessionPayload {
  clientId: string;
  cartId: string;
  checkoutUrl: string;
}

export async function handleCheckoutSession(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: CheckoutSessionPayload | undefined;
  try {
    body = (await request.json()) as CheckoutSessionPayload;
  } catch (error) {
    console.error("[checkout-session] failed to parse body", error);
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return new Response("Invalid payload", { status: 400 });
  }

  const clientId = body.clientId?.trim();
  const cartId = body.cartId?.trim();
  const checkoutUrl = body.checkoutUrl?.trim();

  if (!clientId || !cartId || !checkoutUrl) {
    return new Response("Missing required fields", { status: 400 });
  }

  const storedAt = new Date().toISOString();
  const record = JSON.stringify({
    clientId,
    cartId,
    checkoutUrl,
    storedAt,
  });

  try {
    await Promise.all([
      env.CART_KV_BINDING.put(`checkout:cart:${cartId}`, record, {
        expirationTtl: EXPIRATION_TTL_SECONDS,
      }),
      env.CART_KV_BINDING.put(`checkout:client:${clientId}`, cartId, {
        expirationTtl: EXPIRATION_TTL_SECONDS,
      }),
    ]);
  } catch (error) {
    console.error("[checkout-session] failed to persist", error);
    return new Response("Failed to persist session", { status: 500 });
  }

  return new Response(null, { status: 204 });
}
