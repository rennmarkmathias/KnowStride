// functions/api/stripe-webhook.js
import Stripe from "stripe";
import { prodigiCreateOrder, prodigiSkuFor } from "./_prodigi.js";
import { sendOrderReceivedEmail } from "./_mail.js";

function asText(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Prodigi sizing accepted values:
 * - fillPrintArea (may crop)
 * - fitPrintArea  (may add border)
 *
 * STRICT => fillPrintArea (looks “poster-tight”)
 * ART    => fitPrintArea (safer, preserves whole image)
 */
function normalizeSizing(mode, provided = "") {
  const m = String(mode || "").toUpperCase();
  const p = String(provided || "").toLowerCase();

  if (p.includes("fill") || p.includes("crop")) return "fillPrintArea";
  if (p.includes("fit") || p.includes("shrink")) return "fitPrintArea";

  return m === "STRICT" ? "fillPrintArea" : "fitPrintArea";
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
    return new Response(`Webhook signature verification failed: ${err?.message || String(err)}`, { status: 400 });
  }

  if (event.type !== "checkout.session.completed") {
    return new Response("ok", { status: 200 });
  }

  const sessionId = event.data.object?.id;

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "payment_intent", "payment_intent.latest_charge", "customer_details"],
    });

    // Only handle posters
    if (session.metadata?.kind && session.metadata.kind !== "poster") {
      return new Response("ok", { status: 200 });
    }

    const posterId = session.metadata?.poster_id || session.metadata?.posterId || null;
    const posterTitle = session.metadata?.poster_title || session.metadata?.posterTitle || null;
    const size = session.metadata?.size || null;
    const paper = session.metadata?.paper || null; // "standard" / "fineart"
    const mode = session.metadata?.mode || null;   // "STRICT" / "ART"
    const printUrl = session.metadata?.print_url || session.metadata?.printUrl || null;

    const clerkUserId =
      session.metadata?.clerk_user_id ||
      session.metadata?.clerkUserId ||
      session.metadata?.user_id ||
      null;

    if (!posterId || !size || !paper || !mode || !printUrl) {
      throw new Error(`Missing required metadata. posterId=${posterId} size=${size} paper=${paper} mode=${mode} printUrl=${printUrl}`);
    }

    const qty = session.line_items?.data?.[0]?.quantity || 1;

    // Shipping (prefer collected_information.shipping_details)
    const shippingDetails =
      session.collected_information?.shipping_details ||
      session.shipping_details ||
      (session.customer_details?.address
        ? { name: session.customer_details?.name || "Customer", address: session.customer_details.address }
        : null) ||
      (session.payment_intent?.latest_charge?.shipping
        ? { name: session.payment_intent.latest_charge.shipping.name, address: session.payment_intent.latest_charge.shipping.address }
        : null);

    if (!shippingDetails?.address) {
      throw new Error("Missing shipping address on Stripe session");
    }

    const addr = shippingDetails.address;

    // Prodigi recipient address (don’t send empty optionals)
    const recipientAddress = {
      line1: asText(addr.line1) || "",
      townOrCity: asText(addr.city) || "",
      postalOrZipCode: asText(addr.postal_code) || "",
      countryCode: asText(addr.country) || "",
    };
    if (addr.line2) recipientAddress.line2 = asText(addr.line2);
    if (addr.state) recipientAddress.stateOrCounty = asText(addr.state);

    const customerEmail = asText(session.customer_details?.email) || null;

    const recipient = {
      name: asText(shippingDetails.name) || asText(session.customer_details?.name) || "Customer",
      email: customerEmail || undefined,
      address: recipientAddress,
    };

    // Amount in MINOR units (cents)
    const amountTotalMinor = Number(session.amount_total || 0);
    const currency = asText(session.currency) || "usd";

    // --- DB: idempotency & store stripe_received first
    if (env.DB) {
      const existing = await env.DB.prepare(
        `SELECT prodigi_order_id FROM orders WHERE stripe_session_id = ? LIMIT 1`
      ).bind(session.id).first();

      if (existing?.prodigi_order_id) {
        return new Response("ok", { status: 200 });
      }

      await env.DB.prepare(
        `INSERT INTO orders
          (id, created_at, email, clerk_user_id, poster_id, poster_title, size, paper, mode, currency,
           amount_total, stripe_session_id, stripe_payment_intent_id, status, updated_at)
         VALUES
          (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(stripe_session_id) DO UPDATE SET
          email = COALESCE(excluded.email, orders.email),
          clerk_user_id = COALESCE(excluded.clerk_user_id, orders.clerk_user_id),
          poster_title = COALESCE(excluded.poster_title, orders.poster_title),
          currency = COALESCE(excluded.currency, orders.currency),
          amount_total = COALESCE(excluded.amount_total, orders.amount_total),
          stripe_payment_intent_id = COALESCE(excluded.stripe_payment_intent_id, orders.stripe_payment_intent_id),
          status = CASE
            WHEN orders.prodigi_order_id IS NOT NULL THEN orders.status
            ELSE excluded.status
          END,
          updated_at = datetime('now')
        `
      )
        .bind(
          crypto.randomUUID(),
          customerEmail,
          asText(clerkUserId),
          asText(posterId),
          asText(posterTitle),
          asText(size),
          asText(paper),
          asText(mode),
          currency,
          amountTotalMinor, // ✅ cents in DB
          asText(session.id),
          asText(session.payment_intent) || null,
          "stripe_received"
        )
        .run();
    }

    // Race-safe: check again
    if (env.DB) {
      const existing2 = await env.DB.prepare(
        `SELECT prodigi_order_id FROM orders WHERE stripe_session_id = ? LIMIT 1`
      ).bind(session.id).first();

      if (existing2?.prodigi_order_id) {
        return new Response("ok", { status: 200 });
      }
    }

    // --- Create Prodigi order
    const prodigiSku = prodigiSkuFor(env, { paper, size });
    const sizing = normalizeSizing(mode, session.metadata?.sizing || "");

    const prodigiOrderPayload = {
      merchantReference: `ks_${session.id}`,
      shippingMethod: "Standard",
      recipient,
      items: [
        {
          sku: prodigiSku,
          copies: qty,
          sizing,
          assets: [{ url: printUrl, printArea: "default" }],
        },
      ],
    };

    const prodigiResult = await prodigiCreateOrder(env, prodigiOrderPayload);
    if (!prodigiResult?.ok) {
      throw new Error(`Prodigi create order failed: ${asText(prodigiResult?.error) || "unknown"}`);
    }

    const prodigi = prodigiResult.response || {};
    const prodigiOrderId = asText(prodigi.id || prodigi.orderId || prodigi.order?.id) || null;

    // --- DB update: prodigi created
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

    // --- Email: Order received (non-fatal)
    try {
      await sendOrderReceivedEmail(env, {
        to: customerEmail,
        posterTitle: posterTitle || posterId,
        size,
        paper,
        mode,
        amountTotalMinor,
        currency,
        prodigiOrderId,
        accountUrl: "https://knowstride.com/account.html",
      });
    } catch (e) {
      console.log("[mail] order received failed", e?.message || String(e));
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }
}
