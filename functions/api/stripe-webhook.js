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

  if (event.type !== "checkout.session.completed") {
    return new Response("ok", { status: 200 });
  }

  const sessionFromEvent = event.data.object;
  const sessionId = sessionFromEvent.id;

  try {
    // (Valfritt men bra) Idempotency: om vi redan har sessionen i D1, gör inget mer
    if (env.DB) {
      try {
        const existing = await env.DB
          .prepare("SELECT id FROM orders WHERE stripe_session_id = ? LIMIT 1")
          .bind(sessionId)
          .first();
        if (existing) return new Response("ok", { status: 200 });
      } catch (e) {
        // fortsätt ändå
        console.error("D1 idempotency check failed:", e);
      }
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "payment_intent", "payment_intent.latest_charge", "customer_details"],
    });

    const posterId = session.metadata?.poster_id || null;
    const posterTitle = session.metadata?.poster_title || null;
    const size = session.metadata?.size || null;
    const paper = session.metadata?.paper || null;
    const mode = session.metadata?.mode || null;
    const printUrl = session.metadata?.print_url || null;
    const clerkUserId = session.metadata?.clerk_user_id || null;

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
        line2: addr.line2 || "",
        townOrCity: addr.city || "",
        stateOrCounty: addr.state || "",
        postalOrZipCode: addr.postal_code || "",
        countryCode: addr.country || "",
      },
    };

    const prodigiSku = prodigiSkuFor(env, { paper, size });

    const prodigiOrderPayload = {
      merchantReference: `ks_${session.id}`,
      shippingMethod: "Standard",
      recipient,
      items: [
        {
          sku: prodigiSku,
          copies: qty,
          assets: [{ url: printUrl }],
        },
      ],
    };

    const prodigiOrder = await prodigiCreateOrder(env, prodigiOrderPayload);

    // ✅ D1 är “nice-to-have”: om den failar ska vi INTE returnera 500 och trigga Stripe retries
    if (env.DB) {
      try {
        const total = session.amount_total || 0;
        const currency = session.currency || "usd";
        const paymentIntentId =
          typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null;

        await env.DB.prepare(
          `INSERT INTO orders
            (id, clerk_user_id, email, poster_id, poster_title, size, paper, mode, quantity,
             amount_total, currency, stripe_session_id, stripe_payment_intent_id,
             prodigi_order_id, status, created_at)
           VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            crypto.randomUUID(),
            clerkUserId,
            session.customer_details?.email || null,
            posterId,
            posterTitle,
            size,
            paper,
            mode,
            qty,
            total,
            currency,
            session.id,
            paymentIntentId,
            prodigiOrder?.id || prodigiOrder?.orderId || null,
            "prodigi_created",
            new Date().toISOString()
          )
          .run();
      } catch (e) {
        console.error("D1 insert failed (non-fatal):", e);
      }
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }
}
