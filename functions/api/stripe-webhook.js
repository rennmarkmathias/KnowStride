// functions/api/stripe-webhook.js

import Stripe from "stripe";
import { prodigiCreateOrder, prodigiSkuFor } from "./_prodigi.js";
import { sendOrderReceivedEmail } from "./_mail.js";

// Stripe amounts are in the smallest currency unit (e.g. cents). Convert to a
// major unit number for display/storage.
function amountToMajor(amountMinor, currency) {
  const c = String(currency || "").toLowerCase();

  // Common 0-decimal currencies (Stripe treats these as whole units).
  const zeroDecimal = new Set([
    "bif",
    "clp",
    "djf",
    "gnf",
    "jpy",
    "kmf",
    "krw",
    "mga",
    "pyg",
    "rwf",
    "ugx",
    "vnd",
    "vuv",
    "xaf",
    "xof",
    "xpf",
  ]);

  // A few 3-decimal currencies.
  const threeDecimal = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

  const n = Number(amountMinor || 0);
  if (zeroDecimal.has(c)) return n;
  if (threeDecimal.has(c)) return n / 1000;
  return n / 100;
}

function cleanAddressField(v) {
  const s = (v ?? "").toString().trim();
  return s.length ? s : null;
}

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

    console.log("stripe-webhook", {
      sessionId: session.id,
      amount_total: session.amount_total,
      currency: session.currency,
      customer_email: session.customer_details?.email,
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

    // Prodigi validates that some optional fields are either omitted or non-empty.
    // So we only include line2/state when they exist.
    const recipient = {
      name: shippingDetails.name || session.customer_details?.name || "Customer",
      email: session.customer_details?.email || undefined,
      address: {
        line1: addr.line1 || "",
        ...(addr.line2 ? { line2: addr.line2 } : {}),
        townOrCity: addr.city || "",
        ...(addr.state ? { stateOrCounty: addr.state } : {}),
        postalOrZipCode: addr.postal_code || "",
        countryCode: addr.country || "",
      },
    };

    // SKU från env-vars (Cloudflare)
    const prodigiSku = prodigiSkuFor(env, { paper, size });

    // --- DB upsert + idempotency ---
    // We want:
    //  1) Only ONE Prodigi order per Stripe session (even if Stripe retries or you click "Resend").
    //  2) Always update the SAME DB row with prodigi_order_id/status.
    let existing = null;
    if (env.DB) {
      existing = await env.DB.prepare(
        `SELECT id, prodigi_order_id FROM orders WHERE stripe_session_id = ? LIMIT 1`
      )
        .bind(session.id)
        .first();
    }

    // If we already created a Prodigi order for this Stripe session, we're done.
    if (existing?.prodigi_order_id) {
      return new Response("ok", { status: 200 });
    }

    // Ensure we have a DB row as early as possible.
    if (env.DB && !existing?.id) {
      const clerkUserId =
        session.metadata?.clerk_user_id ||
        session.metadata?.clerkUserId ||
        null;

      const email = session.customer_details?.email || null;

      const currency = (session.currency || "usd").toLowerCase();
      const totalMinor = Number(session.amount_total || 0);
      const totalMajor = amountToMajor(totalMinor, currency);

      await env.DB.prepare(
        `INSERT INTO orders
          (id, created_at, email, clerk_user_id, poster_id, poster_title, size, paper, mode, currency, amount_total,
           stripe_session_id, stripe_payment_intent_id, status)
         VALUES
          (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          "stripe_received"
        )
        .run();

      existing = await env.DB.prepare(
        `SELECT id, prodigi_order_id FROM orders WHERE stripe_session_id = ? LIMIT 1`
      )
        .bind(session.id)
        .first();
    }

    // --- Create Prodigi order ---
    // Prodigi expects sizing to be one of the allowed values. "ShrinkToFit" is the safest default.
    const prodigiOrderPayload = {
      merchantReference: `ks_${session.id}`,
      shippingMethod: "Standard",
      recipient,
      items: [
        {
          sku: prodigiSku,
          copies: qty,
          sizing: "ShrinkToFit",
          assets: [{ url: printUrl, printArea: "default" }],
        },
      ],
    };

    const prodigiOrder = await prodigiCreateOrder(env, prodigiOrderPayload);
    const prodigiOrderId =
      prodigiOrder?.id ||
      prodigiOrder?.orderId ||
      prodigiOrder?.response?.id ||
      prodigiOrder?.response?.orderId ||
      null;
    const prodigiStatus =
      prodigiOrder?.status ||
      prodigiOrder?.response?.status ||
      null;

    // Update the SAME DB row with Prodigi info.
    if (env.DB && existing?.id) {
      await env.DB.prepare(
        `UPDATE orders
            SET prodigi_order_id = ?,
                prodigi_status = COALESCE(?, prodigi_status),
                status = 'prodigi_created'
          WHERE id = ?`
      )
        .bind(prodigiOrderId, prodigiStatus, existing.id)
        .run();
    }

    // Optional: email confirmation to the customer.
    // Sends only if email provider env vars are configured.
    await sendOrderReceivedEmail(env, {
      to: session.customer_details?.email || null,
      name: recipient.name,
      posterTitle,
      size,
      paper,
      mode,
      amountTotalMajor: totalMajor,
      currency,
      prodigiOrderId,
    });

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }
}
