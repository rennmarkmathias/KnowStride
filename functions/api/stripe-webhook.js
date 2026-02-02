// functions/api/stripe-webhook.js

import Stripe from "stripe";
import { prodigiCreateOrder, prodigiSkuFor } from "./_prodigi.js";

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

  // Vi hanterar bara posters
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
    const size = session.metadata?.size || null;       // "12x18"
    const paper = session.metadata?.paper || null;     // "standard" / "fine_art"
    const mode = session.metadata?.mode || null;       // "STRICT" / "ART"
    const printUrl = session.metadata?.print_url || session.metadata?.printUrl || null;

    if (!posterId || !size || !paper || !mode || !printUrl) {
      throw new Error(
        `Missing required metadata. posterId=${posterId} size=${size} paper=${paper} mode=${mode} printUrl=${printUrl}`
      );
    }

    const qty = session.line_items?.data?.[0]?.quantity || 1;

    // Shipping (robust)
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

    const recipient = {
      name: shippingDetails.name || session.customer_details?.name || "Customer",
      email: session.customer_details?.email || undefined,
      address: {
        line1: addr.line1 || "",
        line2: addr.line2 ? addr.line2 : undefined,                 // viktigt: inte tom sträng
        townOrCity: addr.city || "",
        stateOrCounty: addr.state ? addr.state : undefined,          // viktigt: inte tom sträng
        postalOrZipCode: addr.postal_code || "",
        countryCode: addr.country || "",
      },
    };

    // SKU från env-vars (Cloudflare)
    const prodigiSku = prodigiSkuFor(env, { paper, size });

    // Prodigi sizing: måste vara en tillåten sträng
    // STRICT = ingen crop, ART = fyll/crop
    const sizing = mode === "ART" ? "fillPrintArea" : "fitPrintArea";

    const prodigiOrderPayload = {
      merchantReference: `ks_${session.id}`,
      shippingMethod: "Standard",
      recipient,
      items: [
        {
          sku: prodigiSku,
          copies: qty,
          sizing,
          assets: [{ printArea: "default", url: printUrl }],
        },
      ],
    };

    const prodigiOrder = await prodigiCreateOrder(env, prodigiOrderPayload);

    // Spara i D1 om DB finns
    if (env.DB) {
      const userId = session.metadata?.user_id || null;
      const total = session.amount_total || 0;
      const currency = session.currency || "usd";

      await env.DB.prepare(
        `INSERT INTO orders
          (id, user_id, stripe_session_id, prodigi_order_id, poster_id, paper, size, mode, quantity, amount_total, currency, status, created_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          userId,
          session.id,
          prodigiOrder?.id || prodigiOrder?.orderId || null,
          posterId,
          paper,
          size,
          mode,
          qty,
          total,
          currency,
          "prodigi_created",
          Date.now()
        )
        .run();
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }
}
