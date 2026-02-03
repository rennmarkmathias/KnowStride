// functions/api/stripe-webhook.js

import Stripe from "stripe";
import { prodigiCreateOrder, prodigiSkuFor } from "./_prodigi.js";

// hjälp: D1 gillar inte objects
function asText(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
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
    const posterTitle = session.metadata?.poster_title || null;
    const size = session.metadata?.size || null;       // "12x18"
    const paper = session.metadata?.paper || null;     // "standard" / "fineart"
    const mode = session.metadata?.mode || null;       // "STRICT" / "ART"
    const printUrl = session.metadata?.print_url || session.metadata?.printUrl || null;

    if (!posterId || !size || !paper || !mode || !printUrl) {
      throw new Error(
        `Missing required metadata. posterId=${posterId} size=${size} paper=${paper} mode=${mode} printUrl=${printUrl}`
      );
    }

    const qty = session.line_items?.data?.[0]?.quantity || 1;

    // shipping robust
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

    // =========================
    // DB: idempotens + “enhet”
    // =========================
    const hasDB = Boolean(env.DB);
    let existing = null;

    if (hasDB) {
      const row = await env.DB.prepare(
        `SELECT id, prodigi_order_id, status
         FROM orders
         WHERE stripe_session_id = ?
         LIMIT 1`
      ).bind(session.id).first();

      existing = row || null;

      // ✅ Viktigt: om vi redan har skapat Prodigi-order för denna session: skapa inte igen vid Resend.
      if (existing?.prodigi_order_id || existing?.status === "prodigi_created") {
        return new Response("ok", { status: 200 });
      }
    }

    // =========================
    // Skapa order i Prodigi
    // =========================
    const prodigiOrderPayload = {
      merchantReference: `ks_${session.id}`,
      shippingMethod: "Standard",
      recipient,
      items: [
        {
          sku: prodigiSku,
          copies: qty,
          assets: [{ url: printUrl }],
          sizing: "Crop", // standardval som Prodigi accepterar
        },
      ],
    };

    const prodigiOrder = await prodigiCreateOrder(env, prodigiOrderPayload);

    const prodigiOrderId =
      prodigiOrder?.response?.id ||
      prodigiOrder?.response?.orderId ||
      null;

    // =========================
    // Spara/uppdatera D1
    // =========================
    if (hasDB) {
      const clerkUserId = session.metadata?.clerk_user_id || null;
      const email = session.customer_details?.email || null;

      // ✅ Spara i “minor units” (cents), för att matcha account.html (som delar /100)
      const amountTotalMinor = Number(session.amount_total ?? 0);
      const currency = session.currency || "usd";

      if (!existing) {
        await env.DB.prepare(
          `INSERT INTO orders
            (id, created_at, email, clerk_user_id,
             poster_id, poster_title, size, paper, mode,
             currency, amount_total,
             stripe_session_id, stripe_payment_intent_id,
             prodigi_order_id, prodigi_status, status)
           VALUES
            (?, ?, ?, ?,
             ?, ?, ?, ?, ?,
             ?, ?,
             ?, ?,
             ?, ?, ?)`
        )
          .bind(
            crypto.randomUUID(),
            Date.now(),
            asText(email),
            asText(clerkUserId),

            asText(posterId),
            asText(posterTitle),
            asText(size),
            asText(paper),
            asText(mode),

            asText(currency),
            amountTotalMinor,

            asText(session.id),
            asText(session.payment_intent),

            asText(prodigiOrderId),
            null,
            "prodigi_created"
          )
          .run();
      } else {
        await env.DB.prepare(
          `UPDATE orders
           SET
             prodigi_order_id = ?,
             status = 'prodigi_created'
           WHERE stripe_session_id = ?`
        )
          .bind(asText(prodigiOrderId), asText(session.id))
          .run();
      }
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }
}
