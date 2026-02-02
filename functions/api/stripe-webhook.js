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

  const stripe = new Stripe(stripeSecret, { apiVersion: "2024-06-20" });

  const sig = request.headers.get("stripe-signature");
  let event;

  const body = await request.text();

  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    return new Response(`Webhook signature verification failed: ${err.message}`, { status: 400 });
  }

  // Vi hanterar bara posters-checkout
  if (event.type !== "checkout.session.completed") {
    return new Response("ok", { status: 200 });
  }

  const sessionFromEvent = event.data.object;
  const sessionId = sessionFromEvent.id;

  try {
    // Hämta full session med line_items + payment_intent (för robust shipping fallback om Stripe beter sig)
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "payment_intent", "payment_intent.latest_charge", "customer_details"],
    });

    // Metadata vi satte i create-poster-checkout-session.js
    const posterId = session.metadata?.poster_id || session.metadata?.posterId || null;
    const size = session.metadata?.size || null;      // ex "12x18"
    const paper = session.metadata?.paper || null;    // ex "blp" eller "fap"
    const mode = session.metadata?.mode || null;      // ex "strict" / "art"
    const printUrl = session.metadata?.print_url || session.metadata?.printUrl || null;

    if (!posterId || !size || !paper || !mode || !printUrl) {
      throw new Error(
        `Missing required metadata. posterId=${posterId} size=${size} paper=${paper} mode=${mode} printUrl=${printUrl}`
      );
    }

    const qty = session.line_items?.data?.[0]?.quantity || 1;

    // --- Shipping details (robust) ---
    // Primärt: session.shipping_details (brukar finnas för fysiska produkter)
    // Fallback: session.customer_details.address
    // Extra fallback: charge.shipping / billing_details (sista utvägen)
    const shippingDetails =
      session.shipping_details ||
      (session.customer_details?.address
        ? { name: session.customer_details?.name || "Customer", address: session.customer_details.address }
        : null) ||
      (session.payment_intent?.latest_charge?.shipping
        ? { name: session.payment_intent.latest_charge.shipping.name, address: session.payment_intent.latest_charge.shipping.address }
        : null);

    if (!shippingDetails || !shippingDetails.address) {
      // Detta gör att Stripe retryar. Viktigt om Stripe ibland skickar completed innan shipping-data sitter (ovanligt men kan hända).
      throw new Error("Missing shipping address on Stripe session");
    }

    const addr = shippingDetails.address;

    // Stripe använder ofta: line1/line2/city/postal_code/state/country
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

    // --- SKU mapping (från env vars du lade in i Cloudflare) ---
    // paper: "blp" = Budget/Standard, "fap" = Fine Art (Enhanced Matte)
    const prodigiSku = prodigiSkuFor(env, { paper, size });

    // --- Build Prodigi order payload ---
    // Viktigt: Prodigi vill ha items med sku + assets + copies
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

    // Skapa order i Prodigi
    const prodigiOrder = await prodigiCreateOrder(env, prodigiOrderPayload);

    // Spara i D1 orders-tabell (om du har D1 bindad som DB)
    // Om du inte har DB binding i Cloudflare Pages, kommentera bort detta block.
    if (env.DB) {
      const userId = session.metadata?.user_id || null; // finns om köp initieras när man är inloggad
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
    // Stripe kommer retrya om vi returnerar 500
    return new Response(`Webhook handler error: ${err.message}`, { status: 500 });
  }
}
