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

  // Cloudflare/Workers: använd fetch-http-client
  const stripe = new Stripe(stripeSecret, {
    apiVersion: "2024-06-20",
    httpClient: Stripe.createFetchHttpClient(),
  });

  const sig = request.headers.get("stripe-signature");
  const body = await request.text();

  let event;
  try {
    // ✅ Cloudflare kräver async verifiering
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
    const paper = session.metadata?.paper || null;     // "standard"/"fineart"/"blp"/"fap" etc
    const mode = session.metadata?.mode || null;       // "STRICT" / "ART"
    const printUrl = session.metadata?.print_url || session.metadata?.printUrl || null;

    if (!posterId || !size || !paper || !mode || !printUrl) {
      throw new Error(
        `Missing required metadata. posterId=${posterId} size=${size} paper=${paper} mode=${mode} printUrl=${printUrl}`
      );
    }

    const qty = session.line_items?.data?.[0]?.quantity || 1;

    // Shipping (robust): använd primärt collected_information.shipping_details om den finns
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
      // Stripe kommer retry:a webhooken om vi returnerar 500
      throw new Error("Missing shipping address on Stripe session");
    }

    const addr = shippingDetails.address;

    const recipient = {
      name: shippingDetails.name || session.customer_details?.name || "Customer",
      email: session.customer_details?.email || undefined,
      address: {
        line1: addr.line1 || "",
        line2: addr.line2 || "",
        townOrCity: addr.city || "",
        stateOrCounty: addr.state || "",
        postalOrZipCode: addr.postal_code || "",
        countryCode: addr.country || "",
      },
    };

    // SKU från env-vars (Cloudflare)
    const prodigiSku = prodigiSkuFor(env, { paper, size });

    // ✅ Idempotens: om DB finns och ordern redan finns, returnera ok (Resend ska inte skapa ny)
    if (env.DB) {
      const existing = await env.DB.prepare(
        `SELECT id, prodigi_order_id FROM orders WHERE stripe_session_id = ? LIMIT 1`
      )
        .bind(session.id)
        .first();

      if (existing?.id) {
        return new Response("ok", { status: 200 });
      }
    }

    // ✅ Prodigi kräver "sizing" och här ska den vara ett giltigt värde
    // För posters funkar "fillPrintArea" (inte Crop/ShrinkToFit).
    const prodigiOrderPayload = {
      merchantReference: `ks_${session.id}`,
      shippingMethod: "Standard",
      recipient,
      items: [
        {
          sku: prodigiSku,
          copies: qty,
          sizing: "fillPrintArea",
          assets: [{ url: printUrl }],
        },
      ],
    };

    // Skapa order i Prodigi
    const prodigiOrder = await prodigiCreateOrder(env, prodigiOrderPayload);

    // Spara i D1 om DB finns
    if (env.DB) {
      const clerkUserId =
        session.metadata?.clerk_user_id ||
        session.metadata?.clerkUserId ||
        null;

      const email = session.customer_details?.email || null;

      // Stripe amount_total är i minor units (t.ex. cents) → spara i major units
      const currency = (session.currency || "usd").toLowerCase();
      const totalMinor = Number(session.amount_total || 0);
      const totalMajor = Number.isFinite(totalMinor) ? totalMinor / 100 : 0;

      await env.DB.prepare(
        `INSERT INTO orders
          (id, created_at, email, clerk_user_id, poster_id, poster_title, size, paper, mode, currency, amount_total,
           stripe_session_id, stripe_payment_intent_id, prodigi_order_id, status)
         VALUES
          (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          email,
          clerkUserId,
          posterId,
          session.metadata?.poster_title || null,
          size,
          paper,
          mode,
          currency,
          totalMajor,
          session.id,
          session.payment_intent || null,
          prodigiOrder?.response?.id || prodigiOrder?.response?.orderId || null,
          "stripe_received"
        )
        .run();
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }
}
