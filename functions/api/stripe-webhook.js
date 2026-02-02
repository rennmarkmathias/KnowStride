// functions/api/stripe-webhook.js

import Stripe from "stripe";
import { prodigiCreateOrder, prodigiSkuFor } from "./_prodigi.js";

function normalizePaper(paperRaw) {
  if (!paperRaw) return null;
  const p = String(paperRaw).trim().toLowerCase();
  // UI kan skicka standard/fine_art, backend vill ha blp/fap
  if (p === "blp" || p === "standard") return "blp";
  if (p === "fap" || p === "fine_art" || p === "fineart" || p === "fine art") return "fap";
  return p;
}

/**
 * Normalisera storlekar så de matchar env-namnen och SKU-lookup.
 * Ex: "12X18" -> "12x18", "A2A" -> "a2"
 */
function normalizeSize(sizeRaw) {
  if (!sizeRaw) return null;
  const s = String(sizeRaw).trim().toLowerCase().replace(/\s+/g, "");
  if (s === "a2a") return "a2"; // legacy-typo
  return s;
}

function cleanStr(v) {
  const s = v == null ? "" : String(v).trim();
  return s.length ? s : undefined;
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
    // ✅ Cloudflare kräver async verifiering
    event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
  } catch (err) {
    return new Response(`Webhook signature verification failed: ${err?.message || String(err)}`, {
      status: 400,
    });
  }

  // Endast posters
  if (event.type !== "checkout.session.completed") {
    return new Response("ok", { status: 200 });
  }

  const sessionFromEvent = event.data.object;
  const sessionId = sessionFromEvent.id;

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: [
        "line_items",
        "payment_intent",
        "payment_intent.latest_charge",
        "customer_details",
      ],
    });

    // Metadata från create-poster-checkout-session.js
    const posterId = session.metadata?.poster_id || session.metadata?.posterId || null;
    const size = normalizeSize(session.metadata?.size || null); // "12x18" / "18x24" / "a2" / "a3"
    const paper = normalizePaper(session.metadata?.paper || null); // "blp" / "fap"
    const mode = session.metadata?.mode || null; // "STRICT" / "ART"
    const printUrl = session.metadata?.print_url || session.metadata?.printUrl || null;

    if (!posterId || !size || !paper || !mode || !printUrl) {
      throw new Error(
        `Missing required metadata. posterId=${posterId} size=${size} paper=${paper} mode=${mode} printUrl=${printUrl}`
      );
    }

    const qty = session.line_items?.data?.[0]?.quantity || 1;

    // Shipping (robust): primärt collected_information.shipping_details
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

    // Bygg address men SKICKA INTE tomma strängar (Prodigi validerar hårt)
    const address = {
      line1: cleanStr(addr.line1),
      townOrCity: cleanStr(addr.city),
      postalOrZipCode: cleanStr(addr.postal_code),
      countryCode: cleanStr(addr.country),
    };

    const line2 = cleanStr(addr.line2);
    if (line2) address.line2 = line2;

    const state = cleanStr(addr.state);
    if (state) address.stateOrCounty = state;

    // grundkrav
    const missing = ["line1", "townOrCity", "postalOrZipCode", "countryCode"].filter((k) => !address[k]);
    if (missing.length) {
      throw new Error(`Shipping address missing required fields: ${missing.join(", ")}`);
    }

    const recipient = {
      name: cleanStr(shippingDetails.name) || cleanStr(session.customer_details?.name) || "Customer",
      email: cleanStr(session.customer_details?.email),
      address,
    };

    // SKU från env-vars
    const prodigiSku = prodigiSkuFor(env, { paper, size });

    const prodigiOrderPayload = {
      merchantReference: `ks_${session.id}`,
      shippingMethod: "Standard",
      recipient,
      items: [
        {
          sku: prodigiSku,
          copies: qty,

          // ✅ REQUIRED by Prodigi (Crop/ShrinkToFit etc)
          sizing: "Crop", // default och vanligast :contentReference[oaicite:1]{index=1}

          // ✅ REQUIRED: assets[*].printArea
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
