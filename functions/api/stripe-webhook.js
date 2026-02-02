import Stripe from "stripe";
import { prodigiCreateOrder } from "./_prodigi";
import { json } from "./_posters";

/**
 * Cloudflare Pages Function: /api/stripe-webhook
 * Requires env:
 * - STRIPE_SECRET_KEY
 * - STRIPE_WEBHOOK_SECRET
 * - PRODIGI_API_KEY
 * - DB (D1 binding)
 */
export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.STRIPE_SECRET_KEY) return json({ error: "Missing STRIPE_SECRET_KEY" }, 500);
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "Missing STRIPE_WEBHOOK_SECRET" }, 500);
  if (!env.DB) return json({ error: "Missing DB binding" }, 500);

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  const sig = request.headers.get("stripe-signature");
  if (!sig) return json({ error: "Missing stripe-signature header" }, 400);

  const rawBody = await request.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return json({ error: `Webhook signature verification failed: ${err?.message || err}` }, 400);
  }

  // We only care about poster checkouts
  if (event.type !== "checkout.session.completed") {
    return json({ ok: true, ignored: event.type });
  }

  const sessionFromEvent = event.data?.object;
  const sessionId = sessionFromEvent?.id;
  if (!sessionId) return json({ error: "Missing session id" }, 400);

  // Re-fetch to ensure we have full details.
  // IMPORTANT: Do NOT expand shipping_details (Stripe may reject it).
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items"],
    });
  } catch (err) {
    return json({ error: `Failed to retrieve session: ${err?.message || err}` }, 500);
  }

  const md = session?.metadata || {};
  if (md.kind !== "poster") {
    return json({ ok: true, ignored: "not a poster session" });
  }

  const posterId = md.poster_id || "";
  const posterTitle = md.poster_title || "";
  const size = md.size || "";
  const paper = md.paper || "";
  const mode = md.mode || "";
  const printUrl = md.print_url || "";
  const clerkUserId = md.clerk_user_id || null;

  // Shipping info can be in different places depending on Stripe settings / flow.
  const ship = session.shipping_details || null;
  const cust = session.customer_details || null;

  const shippingName = ship?.name || cust?.name || "";
  const shippingAddress =
    ship?.address ||
    cust?.address ||
    null;

  const email = cust?.email || session.customer_email || "";

  // Amount (USD cents)
  const amountTotal = Number(session.amount_total || 0);
  const currency = String(session.currency || "usd").toUpperCase();

  // Save order to D1 (always)
  const createdAtIso = new Date().toISOString();

  // Minimal “status” logic
  let status = "paid";
  if (!shippingAddress) status = "paid_missing_shipping";

  // Create local order row (id = Stripe session id)
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO orders
       (id, created_at, status, poster_id, poster_title, size, paper, mode, amount_total, currency, email, clerk_user_id, shipping_name, shipping_json, print_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      sessionId,
      createdAtIso,
      status,
      posterId,
      posterTitle,
      size,
      paper,
      mode,
      amountTotal,
      currency,
      email,
      clerkUserId,
      shippingName,
      shippingAddress ? JSON.stringify(shippingAddress) : null,
      printUrl
    ).run();
  } catch (err) {
    return json({ error: `DB error saving order: ${err?.message || err}` }, 500);
  }

  // If we still don't have shipping, we cannot send to Prodigi
  if (!shippingAddress) {
    return json({ ok: true, stored: true, prodigi: false, reason: "missing_shipping" });
  }

  // Create Prodigi order
  try {
    const prodigiResult = await prodigiCreateOrder(env, {
      merchantReference: sessionId,
      recipient: {
        name: shippingName || "Customer",
        email: email || undefined,
        address: {
          line1: shippingAddress.line1 || "",
          line2: shippingAddress.line2 || "",
          townOrCity: shippingAddress.city || "",
          stateOrCounty: shippingAddress.state || "",
          postalOrZipCode: shippingAddress.postal_code || "",
          countryCode: shippingAddress.country || "",
        },
      },
      items: [
        {
          // Your Prodigi SKU selection happens inside _prodigi.js via env vars + metadata
          // (paper/size etc)
          posterId,
          posterTitle,
          size,
          paper,
          mode,
          printUrl,
        },
      ],
    });

    // Store Prodigi order id/status on the local order
    await env.DB.prepare(
      `UPDATE orders SET prodigi_order_id = ?, status = ? WHERE id = ?`
    ).bind(
      prodigiResult?.id || null,
      "sent_to_prodigi",
      sessionId
    ).run();

    return json({ ok: true, stored: true, prodigi: true, prodigi_order_id: prodigiResult?.id || null });
  } catch (err) {
    // Keep order saved, but mark error
    try {
      await env.DB.prepare(
        `UPDATE orders SET status = ?, prodigi_error = ? WHERE id = ?`
      ).bind(
        "prodigi_failed",
        String(err?.message || err),
        sessionId
      ).run();
    } catch {
      // ignore secondary error
    }
    return json({ error: `Prodigi create failed: ${err?.message || err}` }, 500);
  }
}
