// functions/api/stripe-webhook.js
import Stripe from "stripe";
import { prodigiCreateOrder, prodigiSkuFor } from "./_prodigi.js";

function asText(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Build Prodigi sizing value.
 * Prodigi is picky about allowed values; we normalize inputs.
 * If Prodigi still complains, we only need to tweak the returned strings here.
 */
function normalizeSizing(input) {
  const raw = (asText(input) || "").trim();
  const k = raw.toLowerCase();

  // Common names people use:
  // - crop
  // - shrinktofit / shrink_to_fit / fit
  if (!k) return "crop";

  if (k === "crop") return "crop";
  if (k === "fit" || k === "shrinktofit" || k === "shrink_to_fit") return "shrinkToFit";
  if (k === "shrinktofit" || k === "shrink-to-fit") return "shrinkToFit";

  // Fallback: try a safe default
  return "crop";
}

export async function onRequestPost(context) {
  const { env, request } = context;

  const stripeSecret = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

  if (!stripeSecret || !webhookSecret) {
    return new Response("Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET", { status: 500 });
  }

  const stripe = new Stripe(stripeSecret, {
    apiVersion: "2024-06-20",
    httpClient: Stripe.createFetchHttpClient(),
  });

  const sig = request.headers.get("stripe-signature");
  const body = await request.text();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
  } catch (err) {
    return new Response(`Webhook signature verification failed: ${err?.message || String(err)}`, {
      status: 400,
    });
  }

  if (event.type !== "checkout.session.completed") {
    return new Response("ok", { status: 200 });
  }

  const sessionFromEvent = event.data.object;
  const sessionId = sessionFromEvent.id;

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "payment_intent", "payment_intent.latest_charge", "customer_details"],
    });

    // Metadata från create-poster-checkout-session.js
    const posterId = session.metadata?.poster_id || session.metadata?.posterId || null;
    const posterTitle = session.metadata?.poster_title || session.metadata?.posterTitle || null;
    const size = session.metadata?.size || null;       // "12x18"
    const paper = session.metadata?.paper || null;     // "standard" / "fineart" etc
    const mode = session.metadata?.mode || null;       // "STRICT" / "ART"
    const printUrl = session.metadata?.print_url || session.metadata?.printUrl || null;

    // Clerk
    const clerkUserId =
      session.metadata?.clerk_user_id ||
      session.metadata?.clerkUserId ||
      session.metadata?.user_id ||
      null;

    if (!posterId || !size || !paper || !mode || !printUrl) {
      throw new Error(
        `Missing required metadata. posterId=${posterId} size=${size} paper=${paper} mode=${mode} printUrl=${printUrl}`
      );
    }

    const qty = session.line_items?.data?.[0]?.quantity || 1;

    // Shipping: prefer collected_information.shipping_details
    const shippingDetails =
      session.collected_information?.shipping_details ||
      session.shipping_details ||
      (session.customer_details?.address
        ? { name: session.customer_details?.name || "Customer", address: session.customer_details.address }
        : null) ||
      (session.payment_intent?.latest_charge?.shipping
        ? {
            name: session.payment_intent.latest_charge.shipping.name,
            address: session.payment_intent.latest_charge.shipping.address,
          }
        : null);

    if (!shippingDetails?.address) {
      throw new Error("Missing shipping address on Stripe session");
    }

    const addr = shippingDetails.address;

    // Build recipient.address WITHOUT empty-string optional fields
    const recipientAddress = {
      line1: asText(addr.line1) || "",
      townOrCity: asText(addr.city) || "",
      postalOrZipCode: asText(addr.postal_code) || "",
      countryCode: asText(addr.country) || "",
    };

    // Optional fields only if present
    if (addr.line2) recipientAddress.line2 = asText(addr.line2);
    if (addr.state) recipientAddress.stateOrCounty = asText(addr.state);

    const recipient = {
      name: asText(shippingDetails.name) || asText(session.customer_details?.name) || "Customer",
      email: asText(session.customer_details?.email) || undefined,
      address: recipientAddress,
    };

    // DB idempotency + store “stripe_received” first so we can retry safely
    if (env.DB) {
      const amountTotalDollars = Number(session.amount_total || 0) / 100;
      const currency = asText(session.currency) || "usd";
      const email = asText(session.customer_details?.email) || null;

      // If already exists and already has prodigi_order_id -> skip everything
      const existing = await env.DB.prepare(
        `SELECT prodigi_order_id FROM orders WHERE stripe_session_id = ? LIMIT 1`
      )
        .bind(session.id)
        .first();

      if (existing?.prodigi_order_id) {
        return new Response("ok", { status: 200 });
      }

      // Upsert by unique stripe_session_id (ux_orders_stripe_session_id)
      await env.DB.prepare(
        `INSERT INTO orders
          (id, created_at, email, clerk_user_id, poster_id, poster_title, size, paper, mode, currency, amount_total, stripe_session_id, status, updated_at)
         VALUES
          (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(stripe_session_id) DO UPDATE SET
          email = COALESCE(excluded.email, orders.email),
          clerk_user_id = COALESCE(excluded.clerk_user_id, orders.clerk_user_id),
          poster_title = COALESCE(excluded.poster_title, orders.poster_title),
          currency = COALESCE(excluded.currency, orders.currency),
          amount_total = COALESCE(excluded.amount_total, orders.amount_total),
          status = CASE
            WHEN orders.prodigi_order_id IS NOT NULL THEN orders.status
            ELSE excluded.status
          END,
          updated_at = datetime('now')
        `
      )
        .bind(
          crypto.randomUUID(),
          email,
          asText(clerkUserId),
          asText(posterId),
          asText(posterTitle),
          asText(size),
          asText(paper),
          asText(mode),
          currency,
          amountTotalDollars,
          asText(session.id),
          "stripe_received"
        )
        .run();
    }

    // If DB exists: check again before creating Prodigi order (race-safe)
    if (env.DB) {
      const existing = await env.DB.prepare(
        `SELECT prodigi_order_id FROM orders WHERE stripe_session_id = ? LIMIT 1`
      )
        .bind(session.id)
        .first();
      if (existing?.prodigi_order_id) {
        return new Response("ok", { status: 200 });
      }
    }

    // SKU from env vars
    const prodigiSku = prodigiSkuFor(env, { paper, size });

    // Fix: assets must include printArea, and sizing must be allowed value
    const sizing = normalizeSizing(session.metadata?.sizing);

    const prodigiOrderPayload = {
      merchantReference: `ks_${session.id}`,
      shippingMethod: "Standard",
      recipient,
      items: [
        {
          sku: prodigiSku,
          copies: qty,
          sizing, // IMPORTANT
          assets: [{ url: printUrl, printArea: "default" }], // IMPORTANT
        },
      ],
    };

    const prodigiResult = await prodigiCreateOrder(env, prodigiOrderPayload);
    if (!prodigiResult?.ok) {
      throw new Error(`Prodigi create order failed: ${asText(prodigiResult?.error) || "unknown"}`);
    }

    const prodigi = prodigiResult.response || {};
    const prodigiOrderId = asText(prodigi.id || prodigi.orderId || prodigi.order?.id) || null;

    // Update DB row with Prodigi info
    if (env.DB) {
      await env.DB.prepare(
        `UPDATE orders
         SET prodigi_order_id = COALESCE(prodigi_order_id, ?),
             status = 'prodigi_created',
             prodigi_status = COALESCE(prodigi_status, 'created'),
             updated_at = datetime('now')
         WHERE stripe_session_id = ?`
      )
        .bind(prodigiOrderId, asText(session.id))
        .run();
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }
}
