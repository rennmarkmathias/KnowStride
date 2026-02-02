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
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "payment_intent", "payment_intent.latest_charge", "customer_details"],
    });

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

    // Robust shipping
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

    // Prodigi gillar inte tomma strängar på vissa fält:
    // - line2: skicka bara om den finns
    // - stateOrCounty: Stripe kan ge null för DE -> fallback till city
    const address = {
      line1: addr.line1 || "",
      postalOrZipCode: addr.postal_code || "",
      countryCode: addr.country || "",
      townOrCity: addr.city || "",
      stateOrCounty: (addr.state || addr.city || "N/A"),
    };
    if (addr.line2) address.line2 = addr.line2;

    const recipient = {
      name: shippingDetails.name || session.customer_details?.name || "Customer",
      email: session.customer_details?.email || undefined,
      address,
    };

    // SKU från env-vars (Cloudflare)
    const prodigiSku = prodigiSkuFor(env, { paper, size });

    // Prodigi v4: sizing ska vara t.ex. "fillPrintArea"
    // och assets behöver printArea: "default"
    const prodigiOrderPayload = {
      merchantReference: `ks_${session.id}`,
      shippingMethod: "Standard",
      recipient,
      items: [
        {
          sku: prodigiSku,
          copies: qty,
          sizing: "fillPrintArea",
          assets: [{ printArea: "default", url: printUrl }],
        },
      ],
    };

    // Skapa order i Prodigi
    const prodigiOrder = await prodigiCreateOrder(env, prodigiOrderPayload);

    // Spara i D1 om DB finns
    if (env.DB) {
      const clerkUserId = session.metadata?.user_id || session.metadata?.clerk_user_id || null;
      const total = session.amount_total || 0;
      const currency = session.currency || "usd";

      try {
        await env.DB.prepare(
          `INSERT INTO orders
            (id, clerk_user_id, stripe_session_id, prodigi_order_id, poster_id, paper, size, mode, amount_total, currency, status, created_at, email)
           VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`
        )
          .bind(
            crypto.randomUUID(),
            clerkUserId,
            session.id,
            prodigiOrder?.id || prodigiOrder?.orderId || null,
            posterId,
            paper,
            size,
            mode,
            total,
            currency,
            "prodigi_created",
            session.customer_details?.email || null
          )
          .run();
      } catch (dbErr) {
        // SUPER-viktigt: om Prodigi redan skapats vill vi INTE att Stripe retry:ar (risk för dubbelorder).
        console.error("D1 insert failed:", dbErr);
      }
    }

    // Returnera alltid 200 när Prodigi-order är skapad
    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }
}
