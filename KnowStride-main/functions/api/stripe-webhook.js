import Stripe from "stripe";
import { findPosterById } from "./_posters";
import { createProdigiOrder, prodigiSkuFor } from "./_prodigi";

/**
 * Stripe webhook (POST) for poster purchases only.
 *
 * Listens to: checkout.session.completed
 * Flow: Stripe -> D1 (orders) -> Prodigi
 *
 * Notes:
 * - We deliberately removed legacy subscription/access handlers to keep this endpoint clean.
 * - Idempotent: safe to "Resend" events from Stripe without creating duplicate orders.
 */
export async function onRequestPost({ request, env }) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  const sig = request.headers.get("stripe-signature");
  if (!sig) return new Response("Missing stripe-signature", { status: 400 });

  const rawBody = await request.arrayBuffer();
  const rawBodyBytes = new Uint8Array(rawBody);

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBodyBytes,
      sig,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return new Response(`Webhook signature error: ${err?.message || err}`, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      await onCheckoutSessionCompleted(stripe, event.data.object, env);
    }
    // Ignore all other event types for this poster-only endpoint.
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || err}`, { status: 500 });
  }

  return new Response("ok", { status: 200 });
}

async function onCheckoutSessionCompleted(stripe, session, env) {
  // Only handle poster checkouts
  if (!(session?.metadata?.kind === "poster" || session?.metadata?.poster_id)) return;
  await onPosterCheckoutSessionCompleted(stripe, session, env);
}

/* ---------------- Poster order flow (Stripe -> DB -> Prodigi) ---------------- */

async function onPosterCheckoutSessionCompleted(stripe, session, env) {
  if (!env.DB) throw new Error("Missing DB binding");
  if (!env.PRODIGI_API_KEY) throw new Error("Missing PRODIGI_API_KEY");

  // Retrieve a full session to be safe (customer_details is expandable; shipping is part of the session object).
  const full = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["customer_details"],
  });

  // Minimal guard
  if (full.payment_status !== "paid") return;

  const md = full.metadata || {};
  const posterId = md.poster_id;
  const paper = md.paper; // "standard" | "fineart"
  const size = md.size;   // "12x18" | "18x24" | "a3" | "a2"
  const mode = md.mode || "STRICT";
  const printUrl = md.print_url;

  if (!posterId || !paper || !size || !printUrl) {
    throw new Error("Missing poster metadata on Stripe session");
  }

  // Idempotency: if Stripe retries this webhook, don't create duplicates.
  const existing = await env.DB.prepare(
    `SELECT id FROM orders WHERE stripe_session_id = ? LIMIT 1`
  )
    .bind(full.id)
    .first();

  if (existing?.id) return;

  const poster = await findPosterById(
    new Request(full.success_url || "https://example.com"),
    env,
    posterId
  );
  const posterTitle = md.poster_title || poster?.title || posterId;

  const orderId = crypto.randomUUID();
  const email = full.customer_details?.email || null;
  const clerkUserId = md.clerk_user_id || null;
  const amountTotal =
    full.amount_total != null ? Number(full.amount_total) / 100 : null;
  const currency = (full.currency || "usd").toLowerCase();

  await env.DB.prepare(
    `INSERT INTO orders (
      id, email, clerk_user_id, poster_id, poster_title,
      size, paper, mode, currency, amount_total,
      stripe_session_id, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      orderId,
      email,
      clerkUserId,
      posterId,
      posterTitle,
      size,
      paper,
      mode,
      currency,
      amountTotal,
      full.id,
      "paid"
    )
    .run();

  // Build Prodigi payload
  const sku = prodigiSkuFor(env, paper, size);
  if (!sku) {
    await env.DB.prepare(`UPDATE orders SET status=? WHERE id=?`)
      .bind("paid_missing_prodigi_sku", orderId)
      .run();
    throw new Error(
      `Missing Prodigi SKU mapping for paper=${paper}, size=${size}`
    );
  }

  // ✅ Correct Stripe shipping fields for Checkout Session
  // full.shipping: { name, address }
  const ship = full.shipping || null;
  const shipAddr = ship?.address || null;

  // Fallback: sometimes customer_details has an address
  const fallbackAddr = full.customer_details?.address || null;
  const addr = shipAddr || fallbackAddr || {};

  // Hard guard: we need enough to ship
  if (!addr?.line1 || !addr?.city || !addr?.postal_code || !addr?.country) {
    await env.DB.prepare(`UPDATE orders SET status=? WHERE id=?`)
      .bind("paid_missing_shipping", orderId)
      .run();
    throw new Error("Missing shipping address on Stripe session");
  }

  const payload = {
    merchantReference: orderId,
    shippingMethod: env.PRODIGI_SHIPPING_METHOD || "Budget",
    recipient: {
      name: ship?.name || full.customer_details?.name || "Customer",
      email: email || undefined,
      address: {
        line1: addr.line1 || "",
        line2: addr.line2 || "",
        postalOrZipCode: addr.postal_code || "",
        townOrCity: addr.city || "",
        stateOrCounty: addr.state || "",
        countryCode: addr.country || "",
      },
    },
    items: [
      {
        sku,
        copies: 1,
        sizing: "fillPrintArea",
        assets: [
          {
            printArea: "default",
            url: printUrl,
          },
        ],
      },
    ],
  };

  let prodigiOrderId = null;
  try {
    const resp = await createProdigiOrder(env, payload);
    prodigiOrderId = resp?.id || resp?.orderId || null;
  } catch (err) {
    await env.DB.prepare(`UPDATE orders SET status=? WHERE id=?`)
      .bind("paid_prodigi_failed", orderId)
      .run();
    throw err;
  }

  await env.DB.prepare(
    `UPDATE orders SET prodigi_order_id=?, status=? WHERE id=?`
  )
    .bind(prodigiOrderId, "sent_to_prodigi", orderId)
    .run();
}
