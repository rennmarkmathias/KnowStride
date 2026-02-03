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

    const address = {
      line1: (addr.line1 || "").trim(),
      townOrCity: (addr.city || "").trim(),
      postalOrZipCode: (addr.postal_code || "").trim(),
      countryCode: (addr.country || "").trim(),
    };

    // Prodigi vill inte ha tomma strängar för valfria fält (line2/stateOrCounty).
    const line2 = (addr.line2 || "").trim();
    if (line2) address.line2 = line2;

    const state = (addr.state || "").trim();
    if (state) address.stateOrCounty = state;

    const recipient = {
      name: (shippingDetails.name || session.customer_details?.name || "Customer").trim(),
      email: session.customer_details?.email || undefined,
      address,
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
          // Vissa Prodigi-SKU:er (t.ex. ART-*) kräver att "sizing" skickas.
          // "ShrinkToFit" är den säkra defaulten (undviker oväntad crop).
          sizing: env.PRODIGI_SIZING || "ShrinkToFit",
        },
      ],
    };

    // --- Idempotency (viktigt) ---
    // Stripe kan skicka samma webhook igen (retries / "Resend" i dashboard).
    // Om vi skapar Prodigi-order varje gång får du dubletter.
    // Lösning: om vi redan har en prodigi_order_id sparad för stripe_session_id,
    // skapa inte en ny Prodigi-order.
    if (env.DB) {
      const existing = await env.DB
        .prepare(`SELECT prodigi_order_id, status FROM orders WHERE stripe_session_id = ? LIMIT 1`)
        .bind(session.id)
        .first();

      if (existing?.prodigi_order_id) {
        return new Response("ok", { status: 200 });
      }

      // "Reservera" session-id i DB innan vi anropar Prodigi.
      // Detta kräver UNIQUE index på orders(stripe_session_id).
      // Om raden redan finns (retry) så gör INSERT OR IGNORE inget.
      const clerkUserId = session.metadata?.clerk_user_id || null;
      const email = session.customer_details?.email || session.customer_email || null;
      const totalMajor = (session.amount_total || 0) / 100;
      const currency = session.currency || "usd";

      await env.DB.prepare(
        `INSERT OR IGNORE INTO orders
          (id, clerk_user_id, email, poster_id, poster_title, size, paper, mode,
           amount_total, currency, stripe_session_id, status, created_at)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          clerkUserId,
          email,
          posterId,
          posterTitle,
          size,
          paper,
          mode,
          totalMajor,
          currency,
          session.id,
          "stripe_received",
          nowMs()
        )
        .run();
    }

    // ✅ Skapa order i Prodigi (nu är vi skyddade mot dubletter via DB)
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

    // ✅ Uppdatera orderraden i D1 (om DB finns)
    if (env.DB) {
      await env.DB
        .prepare(
          `UPDATE orders
             SET prodigi_order_id = COALESCE(?, prodigi_order_id),
                 status = ?,
                 poster_title = COALESCE(poster_title, ?)
           WHERE stripe_session_id = ?`
        )
        .bind(prodigiOrderId, internalStatus, posterTitle, session.id)
        .run();
    }

    // ✅ Viktigt: alltid 200 här så Stripe slutar retry:a på “duplicate”
    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }
}
