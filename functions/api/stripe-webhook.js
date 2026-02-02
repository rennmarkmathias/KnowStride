// functions/api/stripe-webhook.js
import Stripe from "stripe";
import { prodigiCreateOrder, prodigiSkuFor } from "./_prodigi.js";
import { findPosterById } from "./_posters.js";

export const onRequestPost = async ({ request, env }) => {
  try {
    const sig = request.headers.get("stripe-signature");
    if (!sig) return new Response("Missing stripe-signature", { status: 400 });

    const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return new Response("Missing STRIPE_WEBHOOK_SECRET", { status: 500 });
    }

    const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: "2025-01-27.acacia",
    });

    const body = await request.text();

    let event;
    try {
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
    } catch (err) {
      return new Response(`Webhook signature verification failed`, {
        status: 400,
      });
    }

    if (event.type !== "checkout.session.completed") {
      return new Response("ignored", { status: 200 });
    }

    const session = event.data.object;

    // Hämta full session (för metadata, totals, shipping_details, osv)
    const full = await stripe.checkout.sessions.retrieve(session.id);

    if (full.payment_status !== "paid") {
      return new Response("not paid", { status: 200 });
    }

    const md = full.metadata || {};
    const posterId = md.poster_id;
    const size = md.size;
    const paper = md.paper;
    const mode = md.mode || "strict";

    if (!posterId || !size || !paper) {
      return new Response("Missing metadata (poster_id/size/paper)", {
        status: 400,
      });
    }

    // Idempotency: om order redan skapad för session -> gör inget
    const existing = await env.DB.prepare(
      `SELECT id FROM orders WHERE stripe_session_id = ? LIMIT 1`
    )
      .bind(full.id)
      .first();

    if (existing?.id) return new Response("ok", { status: 200 });

    // Poster title (cachea vid köp)
    const poster = await findPosterById(
      new Request(full.success_url || "https://example.com"),
      env,
      posterId
    );

    const posterTitle = md.poster_title || poster?.title || posterId;

    const orderId = crypto.randomUUID();
    const email = full.customer_details?.email || null;
    const clerkUserId = md.clerk_user_id || null;
    const amountTotal =
      full.amount_total != null ? Number(full.amount_total) / 100 : null;
    const currency = (full.currency || "usd").toLowerCase();

    await env.DB.prepare(
      `INSERT INTO orders (
        id, email, clerk_user_id, poster_id, poster_title,
        size, paper, mode, currency, amount_total,
        stripe_session_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        orderId,
        email,
        clerkUserId,
        posterId,
        posterTitle,
        size,
        paper,
        mode,
        currency,
        amountTotal,
        full.id,
        "paid"
      )
      .run();

    // Prodigi SKU
    const sku = prodigiSkuFor(env, paper, size);
    if (!sku) {
      await env.DB.prepare(`UPDATE orders SET status=? WHERE id=?`)
        .bind("paid_missing_prodigi_sku", orderId)
        .run();
      return new Response(
        `Missing Prodigi SKU mapping for paper=${paper}, size=${size}`,
        { status: 500 }
      );
    }

    // ✅ Stripe Checkout Session: shipping_details är rätt fält
    // shipping_details: { name, address: { line1, city, postal_code, country, ... } }
    const ship = full.shipping_details || full.shipping || null;
    const shipAddr = ship?.address || null;

    // Fallbacks (ibland finns billing address här)
    const billingAddr = full.customer_details?.address || null;

    const addr = shipAddr || billingAddr || null;

    // Guard: måste ha minsta för frakt
    if (
      !addr?.line1 ||
      !addr?.city ||
      !addr?.postal_code ||
      !addr?.country
    ) {
      await env.DB.prepare(`UPDATE orders SET status=? WHERE id=?`)
        .bind("paid_missing_shipping", orderId)
        .run();

      return new Response("Missing shipping address on Stripe session", {
        status: 500,
      });
    }

    const recipientName =
      ship?.name || full.customer_details?.name || "Customer";

    // Skapa Prodigi-order
    const payload = {
      merchantReference: orderId,
      shippingMethod: env.PRODIGI_SHIPPING_METHOD || "Budget",
      recipient: {
        name: recipientName,
        email: email || undefined,
        address: {
          line1: addr.line1 || "",
          line2: addr.line2 || "",
          postalOrZipCode: addr.postal_code || "",
          townOrCity: addr.city || "",
          stateOrCounty: addr.state || "",
          countryCode: addr.country || "",
        },
      },
      items: [
        {
          sku,
          copies: 1,
          attributes: {},
          assets: [
            {
              url: md.print_url, // din create-checkout-session lägger in denna
            },
          ],
        },
      ],
    };

    const prodigiRes = await prodigiCreateOrder(env, payload);

    await env.DB.prepare(
      `UPDATE orders SET prodigi_order_id=?, status=? WHERE id=?`
    )
      .bind(prodigiRes?.id || null, "sent_to_print", orderId)
      .run();

    return new Response("ok", { status: 200 });
  } catch (err) {
    // Svara 500 så Stripe visar felet och kan resend
    return new Response(`Webhook handler error: ${err?.message || err}`, {
      status: 500,
    });
  }
};
