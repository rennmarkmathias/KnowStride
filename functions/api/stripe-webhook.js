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

  // Vi hanterar bara completed-checkouts
  if (event.type !== "checkout.session.completed") {
    return new Response("ok", { status: 200 });
  }

  const sessionFromEvent = event.data.object;
  const sessionId = sessionFromEvent.id;

  try {
    // Hämta "riktiga" sessionen + line_items + shipping etc
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["line_items", "payment_intent", "payment_intent.latest_charge", "customer_details"],
    });

    // --- Metadata (från create-poster-checkout-session.js) ---
    const posterId = session.metadata?.poster_id || session.metadata?.posterId || null;
    const posterTitle = session.metadata?.poster_title || session.metadata?.posterTitle || null;

    // size: "12x18", "18x24", "A2", "A3" etc
    const size = session.metadata?.size || null;

    // paper: t.ex "standard" / "fineart" (eller "blp"/"fap" om du kör så)
    const paper = session.metadata?.paper || null;

    // mode: "STRICT" / "ART" etc
    const mode = session.metadata?.mode || null;

    const printUrl = session.metadata?.print_url || session.metadata?.printUrl || null;

    if (!posterId || !size || !paper || !mode || !printUrl) {
      throw new Error(
        `Missing required metadata. posterId=${posterId} size=${size} paper=${paper} mode=${mode} printUrl=${printUrl}`
      );
    }

    const qty = session.line_items?.data?.[0]?.quantity || 1;

    // --- Shipping: robust ---
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

    // Prodigi är kinkig med whitespace/empty: skicka inte tomma fält
    const clean = (v) => {
      const s = String(v ?? "").trim();
      return s.length ? s : null;
    };

    const recipient = {
      name: clean(shippingDetails.name) || clean(session.customer_details?.name) || "Customer",
      email: clean(session.customer_details?.email) || undefined,
      address: {
        line1: clean(addr.line1) || "",
        line2: clean(addr.line2) || undefined,
        townOrCity: clean(addr.city) || "",
        stateOrCounty: clean(addr.state) || undefined,
        postalOrZipCode: clean(addr.postal_code) || "",
        countryCode: clean(addr.country) || "",
      },
    };

    // --- Idempotens (Steg 2) ---
    // 1) Om vi har DB: kolla om order redan finns för denna session
    // 2) Försök reservera raden (processing) före Prodigi-create
    //    Detta blir "race-safe" om du kör UNIQUE index på stripe_session_id.
    const clerkUserId =
      clean(session.metadata?.clerk_user_id) ||
      clean(session.metadata?.user_id) ||
      null;

    const emailForGuest = clean(session.customer_details?.email) || null;

    const amountTotal = session.amount_total ?? null;   // i minsta enhet (USD cents)
    const currency = session.currency || "usd";
    const paymentIntentId = session.payment_intent?.id || session.payment_intent || null;

    if (env.DB) {
      // A) Snabb-check: finns redan en rad?
      const existing = await env.DB
        .prepare(`SELECT id, prodigi_order_id FROM orders WHERE stripe_session_id = ? LIMIT 1`)
        .bind(session.id)
        .first();

      if (existing?.prodigi_order_id) {
        // Redan behandlad => idempotent 200
        return new Response("ok", { status: 200 });
      }

      // B) Reservera sessionen (om unique index finns blir detta race-safe)
      // Om någon annan redan reserverat/skapade så får vi conflict/do nothing,
      // och då kan vi bara returnera 200.
      try {
        await env.DB
          .prepare(`
            INSERT INTO orders (
              id, created_at, email, clerk_user_id,
              poster_id, poster_title, size, paper, mode,
              currency, amount_total, stripe_session_id, stripe_payment_intent_id,
              status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(stripe_session_id) DO NOTHING
          `)
          .bind(
            crypto.randomUUID(),
            Date.now(),
            emailForGuest,
            clerkUserId,
            posterId,
            posterTitle,
            size,
            paper,
            mode,
            currency,
            amountTotal,
            session.id,
            paymentIntentId,
            "processing"
          )
          .run();

        // Efter insert: om någon annan hann före, då finns raden nu.
        const rowNow = await env.DB
          .prepare(`SELECT id, prodigi_order_id, status FROM orders WHERE stripe_session_id = ? LIMIT 1`)
          .bind(session.id)
          .first();

        if (rowNow?.prodigi_order_id) {
          return new Response("ok", { status: 200 });
        }

        // Om status inte är processing kan den vara cancelled/refunded etc.
        // Men normalt: fortsätt till Prodigi-create.
      } catch (e) {
        // Om DB bråkar här: vi kan inte garantera idempotens.
        // Men det är bättre att faila hårt än att skapa dubletter.
        throw new Error(`DB reservation failed: ${e?.message || String(e)}`);
      }
    }

    // --- SKU från env-vars ---
    const prodigiSku = prodigiSkuFor(env, { paper, size });

    // --- Skapa Prodigi order ---
    const prodigiOrderPayload = {
      merchantReference: `ks_${session.id}`,
      shippingMethod: "Standard",
      recipient,
      items: [
        {
          sku: prodigiSku,
          copies: qty,
          assets: [
            // Prodigi kräver assets + printArea (default funkar för posters)
            { url: printUrl, printArea: "default" },
          ],
          // sizing ska INTE skickas om din Prodigi-product inte stödjer det.
          // (Vi skickar ingen "Crop" här.)
        },
      ],
    };

    const prodigiOrder = await prodigiCreateOrder(env, prodigiOrderPayload);
    const prodigiOrderId = prodigiOrder?.id || prodigiOrder?.orderId || null;

    // --- Uppdatera DB (efter lyckad Prodigi-create) ---
    if (env.DB) {
      try {
        await env.DB
          .prepare(`
            UPDATE orders
            SET
              prodigi_order_id = ?,
              status = ?,
              updated_at = ?
            WHERE stripe_session_id = ?
          `)
          .bind(prodigiOrderId, "prodigi_created", Date.now(), session.id)
          .run();
      } catch (e) {
        // Viktigt: returnera ändå 200 så Stripe inte retry:ar och skapar dubletter.
        // Du kan alltid se ordern i Prodigi ändå.
        return new Response(`ok (db update failed: ${e?.message || String(e)})`, { status: 200 });
      }
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }
}
