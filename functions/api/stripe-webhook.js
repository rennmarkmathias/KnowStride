// functions/api/stripe-webhook.js

import Stripe from "stripe";
import { prodigiCreateOrder, prodigiSkuFor } from "./_prodigi.js";

function nowMs() {
  return Date.now();
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

    const posterId = session.metadata?.poster_id || session.metadata?.posterId || null;
    const size = session.metadata?.size || null;        // "12x18" / "a2a"
    const paper = session.metadata?.paper || null;      // "standard" / "fineart" / "blp" / "fap"
    const mode = session.metadata?.mode || null;        // "STRICT" / "ART"
    const printUrl = session.metadata?.print_url || session.metadata?.printUrl || null;
    const posterTitle = session.metadata?.poster_title || session.metadata?.posterTitle || null;

    if (!posterId || !size || !paper || !mode || !printUrl) {
      throw new Error(
        `Missing required metadata. posterId=${posterId} size=${size} paper=${paper} mode=${mode} printUrl=${printUrl}`
      );
    }

    const qty = session.line_items?.data?.[0]?.quantity || 1;

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

    const recipient = {
      name: shippingDetails.name || session.customer_details?.name || "Customer",
      email: session.customer_details?.email || undefined,
      address: {
        line1: (addr.line1 || "").trim(),
        line2: (addr.line2 || "").trim(),
        townOrCity: (addr.city || "").trim(),
        stateOrCounty: (addr.state || "").trim(),
        postalOrZipCode: (addr.postal_code || "").trim(),
        countryCode: (addr.country || "").trim(),
      },
    };

    const prodigiSku = prodigiSkuFor(env, { paper, size });

    // Idempotency “nyckel” hos oss
    const merchantReference = `ks_${session.id}`;

    const prodigiOrderPayload = {
      merchantReference,
      shippingMethod: "Standard",
      recipient,
      items: [
        {
          sku: prodigiSku,
          copies: qty,
          assets: [{ url: printUrl, printArea: "default" }],
          sizing: "Fill", // ✅ Prodigi accepterar "Fill" (inte "Crop")
        },
      ],
    };

    // ✅ Skapa order i Prodigi – men duplicate ska inte ge 500
    const prodigiResult = await prodigiCreateOrder(env, prodigiOrderPayload);

    // prodigiResult.response kan vara:
    // - skapad order (har ofta id/orderId)
    // - duplicate (saknar kanske id)
    const prodigiOrderId =
      prodigiResult?.response?.id ||
      prodigiResult?.response?.orderId ||
      null;

    // Status vi sparar internt
    const internalStatus = prodigiResult.duplicate ? "prodigi_already_created" : "prodigi_created";

    // ✅ Spara i D1 om DB finns – använd UPSERT så Resend inte sabbar
    if (env.DB) {
      const userId = session.metadata?.user_id || null;
      const total = session.amount_total || 0; // Stripe amount_total är i MINSTA enheten (cent)
      const currency = session.currency || "usd";
      const email = session.customer_details?.email || null;

      // OBS: ON CONFLICT kräver att stripe_session_id har UNIQUE index (ni har idx_orders_stripe_session_id)
      await env.DB.prepare(
        `
        INSERT INTO orders
          (id, user_id, email, clerk_user_id, poster_id, poster_title, size, paper, mode,
           amount_total, currency, stripe_session_id, prodigi_order_id, status, created_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stripe_session_id) DO UPDATE SET
          user_id=excluded.user_id,
          email=excluded.email,
          clerk_user_id=excluded.clerk_user_id,
          poster_id=excluded.poster_id,
          poster_title=excluded.poster_title,
          size=excluded.size,
          paper=excluded.paper,
          mode=excluded.mode,
          amount_total=excluded.amount_total,
          currency=excluded.currency,
          prodigi_order_id=COALESCE(excluded.prodigi_order_id, orders.prodigi_order_id),
          status=excluded.status
        `
      )
        .bind(
          crypto.randomUUID(),
          userId,
          email,
          userId,          // om ni använder clerk_user_id = user_id (som innan)
          posterId,
          posterTitle,
          size,
          paper,
          mode,
          total,
          currency,
          session.id,
          prodigiOrderId,
          internalStatus,
          nowMs()
        )
        .run();
    }

    // ✅ Viktigt: alltid 200 här så Stripe slutar retry:a på “duplicate”
    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }
}
