// functions/api/stripe-webhook.js
import Stripe from "stripe";
import { prodigiCreateOrder, prodigiSkuFor } from "./_prodigi.js";
import { sendOrderReceivedEmail } from "./_mail.js";

function asText(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // D1 kan inte binda objects/arrays -> stringify som fallback
  try { return JSON.stringify(v); } catch { return String(v); }
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
    const posterTitle = session.metadata?.poster_title || session.metadata?.posterTitle || null;

    const size = session.metadata?.size || null;       // "12x18"
    const paper = session.metadata?.paper || null;     // "standard"/"blp" / "fineart"/"fap"
    const mode = session.metadata?.mode || null;       // "STRICT" / "ART"
    const printUrl = session.metadata?.print_url || session.metadata?.printUrl || null;

    const clerkUserId = session.metadata?.clerk_user_id || null;

    if (!posterId || !size || !paper || !mode || !printUrl) {
      throw new Error(
        `Missing required metadata. posterId=${posterId} size=${size} paper=${paper} mode=${mode} printUrl=${printUrl}`
      );
    }

    const qty = session.line_items?.data?.[0]?.quantity || 1;

    // Stripe amounts are in minor units (cents)
    const amountTotalMinor = Number(session.amount_total ?? 0);
    const amountTotalMajor = Number.isFinite(amountTotalMinor) ? amountTotalMinor / 100 : 0;
    const currency = (session.currency || "usd").toLowerCase();

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

    // SKU från env-vars
    const prodigiSku = prodigiSkuFor(env, { paper, size });

    // --- Idempotens mot D1: skapa en rad en gång per Stripe-session ---
    if (!env.DB) {
      throw new Error("DB binding missing");
    }

    const existing = await env.DB
      .prepare(`SELECT id, prodigi_order_id FROM orders WHERE stripe_session_id = ? LIMIT 1`)
      .bind(asText(session.id))
      .first();

    const orderId = existing?.id || crypto.randomUUID();

    if (!existing) {
      await env.DB.prepare(
        `INSERT INTO orders
          (id, created_at, email, clerk_user_id, poster_id, poster_title, size, paper, mode,
           currency, amount_total, stripe_session_id, status)
         VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          asText(orderId),
          Date.now(),
          asText(session.customer_details?.email || null),
          asText(clerkUserId),
          asText(posterId),
          asText(posterTitle),
          asText(size),
          asText(paper),
          asText(mode),
          asText(currency),
          amountTotalMajor,            // REAL
          asText(session.id),
          asText("stripe_received")
        )
        .run();
    }

    // --- Skapa order i Prodigi (idempotent via merchantReference) ---
    const prodigiOrderPayload = {
      merchantReference: `ks_${session.id}`,
      shippingMethod: "Standard",
      recipient,
      items: [
        {
          sku: prodigiSku,
          copies: qty,
          sizing: "Fit", // ✅ säkert default (Prodigi kräver tillåtna värden)
          assets: [{ url: printUrl, printArea: "default" }],
        },
      ],
    };

    const prodigiOrder = await prodigiCreateOrder(env, prodigiOrderPayload);

    const prodigiOrderId =
      prodigiOrder?.response?.id ||
      prodigiOrder?.response?.orderId ||
      prodigiOrder?.response?.order?.id ||
      null;

    const prodigiStatus = prodigiOrder?.duplicate ? "duplicate" : "created";

    // Uppdatera samma rad (viktigt för “standard” orderstatus i Account)
    await env.DB.prepare(
      `UPDATE orders
       SET status = ?, prodigi_order_id = ?, prodigi_status = ?
       WHERE id = ?`
    )
      .bind(
        asText("prodigi_created"),
        asText(prodigiOrderId),
        asText(prodigiStatus),
        asText(orderId)
      )
      .run();

    // (valfritt) mail: om RESEND/duplicate vill vi inte spamma.
    // Skicka bara om det var en ny order (inte duplicate)
    if (!prodigiOrder?.duplicate) {
      try {
        await sendOrderReceivedEmail(env, {
          to: session.customer_details?.email,
          name: recipient.name,
          posterTitle: posterTitle || posterId,
          amount: amountTotalMajor,
          currency,
          orderRef: `ks_${session.id}`,
        });
      } catch (e) {
        // mail får inte fälla order-flödet
        console.log("email error:", e?.message || String(e));
      }
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }
}
