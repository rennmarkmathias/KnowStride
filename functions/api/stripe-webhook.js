// functions/api/stripe-webhook.js

import Stripe from "stripe";
import { prodigiCreateOrder, prodigiSkuFor } from "./_prodigi.js";

/**
 * Normalize paper coming from UI/metadata to Prodigi-friendly tokens.
 * UI: "standard" | "fineart"
 * Prodigi mapping: "blp" | "fap"
 */
function normalizePaper(paperRaw) {
  if (!paperRaw) return null;

  const p = String(paperRaw).trim().toLowerCase();

  // Accept already-normalized tokens
  if (p === "blp" || p === "fap") return p;

  // Accept UI tokens
  if (p === "standard") return "blp";
  if (p === "fineart" || p === "fine_art" || p === "fine-art") return "fap";

  // Some people accidentally send "matte"/"gloss" etc — fail loudly:
  return null;
}

export async function onRequestPost(context) {
  const { env, request } = context;

  const stripeSecret = env.STRIPE_SECRET_KEY;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

  if (!stripeSecret || !webhookSecret) {
    return new Response("Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET", { status: 500 });
  }

  // Cloudflare/Workers: use fetch-http-client
  const stripe = new Stripe(stripeSecret, {
    apiVersion: "2024-06-20",
    httpClient: Stripe.createFetchHttpClient(),
  });

  const sig = request.headers.get("stripe-signature");
  const body = await request.text();

  let event;
  try {
    // ✅ Cloudflare requires async verification
    event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
  } catch (err) {
    return new Response(`Webhook signature verification failed: ${err?.message || String(err)}`, {
      status: 400,
    });
  }

  // Only handle posters / completed checkouts
  if (event.type !== "checkout.session.completed") {
    return new Response("ok", { status: 200 });
  }

  const sessionFromEvent = event.data.object;
  const sessionId = sessionFromEvent.id;

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "payment_intent", "payment_intent.latest_charge", "customer_details"],
    });

    // Metadata from create-poster-checkout-session.js
    const posterId = session.metadata?.poster_id || session.metadata?.posterId || null;
    const size = session.metadata?.size || null; // "12x18" / "18x24" / "a2" / "a3" etc.
    const paperRaw = session.metadata?.paper || null; // might be "standard"/"fineart" OR "blp"/"fap"
    const mode = session.metadata?.mode || null; // "STRICT" / "ART"
    const printUrl = session.metadata?.print_url || session.metadata?.printUrl || null;

    // Normalize paper for Prodigi SKU lookup
    const paper = normalizePaper(paperRaw);

    if (!posterId || !size || !paperRaw || !mode || !printUrl) {
      throw new Error(
        `Missing required metadata. posterId=${posterId} size=${size} paper=${paperRaw} mode=${mode} printUrl=${printUrl}`
      );
    }

    if (!paper) {
      throw new Error(
        `Invalid paper metadata value: "${paperRaw}". Expected "standard"|"fineart" or "blp"|"fap".`
      );
    }

    const qty = session.line_items?.data?.[0]?.quantity || 1;

    // Shipping (robust): prefer collected_information.shipping_details if present
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
      // Stripe will retry webhook on 500
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

    // SKU from env-vars (Cloudflare)
    // IMPORTANT: paper must be "blp" or "fap" here.
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

    // Create order in Prodigi
    const prodigiOrder = await prodigiCreateOrder(env, prodigiOrderPayload);

    // Save in D1 if DB exists
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
          // NOTE: store normalized paper (blp/fap) so it matches your env mapping & Prodigi
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

      // If you *want* to store UI paper too, add a column like paper_ui and save paperRaw.
      // (Requires schema change.)
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }
}
