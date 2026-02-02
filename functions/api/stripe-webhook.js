// functions/api/stripe-webhook.js

import Stripe from "stripe";
import { findPosterById } from "./_posters";
import { prodigiCreateOrder, prodigiSkuFor } from "./_prodigi";

export async function onRequestPost({ request, env }) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  const sig = request.headers.get("stripe-signature");
  if (!sig) return new Response("Missing stripe-signature", { status: 400 });

  const rawBody = await request.arrayBuffer();
  const rawBytes = new Uint8Array(rawBody);

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBytes,
      sig,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return new Response(`Webhook signature error: ${err?.message || err}`, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      await handleCheckoutSessionCompleted(stripe, event.data.object, env);
    }
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || err}`, { status: 500 });
  }

  return new Response("ok", { status: 200 });
}

function pickShippingFromSession(session) {
  // Stripe kan lägga adress i olika fält beroende på checkout-flöde.
  const sd = session.shipping_details || null;
  const cd = session.customer_details || null;

  const name = sd?.name || cd?.name || null;
  const address = sd?.address || cd?.address || null;

  if (!address || !address.country) return null;

  return {
    name: name || "Customer",
    address,
  };
}

async function handleCheckoutSessionCompleted(stripe, session, env) {
  // För säkerhets skull: hämta uppdaterad session (utan expand som kan bråka)
  const s = await stripe.checkout.sessions.retrieve(session.id);

  const posterId = s?.metadata?.posterId;
  const size = s?.metadata?.size;
  const paper = s?.metadata?.paper;
  const mode = s?.metadata?.mode || "strict";
  const clerkUserId = s?.metadata?.clerkUserId || null;

  if (!posterId || !size || !paper) {
    throw new Error("Missing metadata on Stripe session (posterId/size/paper)");
  }

  const poster = findPosterById(posterId);
  if (!poster) throw new Error(`Poster not found: ${posterId}`);

  // Email
  const email = s.customer_details?.email || s.customer_email || null;

  // Shipping
  const shipping = pickShippingFromSession(s);

  // Spara order i D1 först (så du alltid ser den i historiken)
  const amountTotal = Number(s.amount_total || 0);
  const currency = (s.currency || "usd").toUpperCase();

  // Minimal DB insert (kräver att orders-tabellen finns)
  // Om den inte finns: detta kastar fel => du ser 500 i Stripe.
  const createdAt = new Date().toISOString();
  const orderId = crypto.randomUUID();

  let status = "paid";
  if (!shipping) status = "paid_missing_shipping";

  await env.DB.prepare(`
    INSERT INTO orders (
      id, created_at, email, clerk_user_id,
      poster_id, title, size, paper, mode,
      currency, amount_total, stripe_session_id,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    orderId, createdAt, email, clerkUserId,
    posterId, poster.title, size, paper, mode,
    currency, amountTotal, s.id,
    status
  ).run();

  // Om shipping saknas: skippa Prodigi nu (men ordern syns i historiken)
  if (!shipping) return;

  // Bygg printfil-URL enligt din filnamnslogik
  // Exempel: /prints/world_history_25_icons_12x18_in_STRICT.png
  const sizePart =
    size.toLowerCase() === "12x18" ? "12x18_in" :
    size.toLowerCase() === "18x24" ? "18x24_in" :
    size.toLowerCase() === "a2" ? "A2_420x594mm" :
    size.toLowerCase() === "a3" ? "A3_297x420mm" :
    size;

  const modePart = (mode || "strict").toUpperCase(); // STRICT / ART

  const assetPath = `${poster.printDir || "/prints"}/${poster.fileBase}_${sizePart}_${modePart}.png`;
  const assetUrl = new URL(assetPath, "https://knowstride.com").toString();

  // SKU
  const sku = prodigiSkuFor(env, { paper, size });

  // Prodigi payload (enkel “order”)
  const prodigiPayload = {
    merchantReference: orderId,
    shippingMethod: "Standard",
    recipient: {
      name: shipping.name,
      address: {
        line1: shipping.address.line1 || "",
        line2: shipping.address.line2 || "",
        postalOrZipCode: shipping.address.postal_code || "",
        townOrCity: shipping.address.city || "",
        stateOrCounty: shipping.address.state || "",
        countryCode: shipping.address.country || "",
      },
      email: email || undefined,
    },
    items: [
      {
        sku,
        copies: 1,
        sizing: "fill",
        assets: [
          { url: assetUrl }
        ],
      },
    ],
  };

  const prodigiRes = await prodigiCreateOrder(env, prodigiPayload);

  const prodigiOrderId =
    prodigiRes?.id ||
    prodigiRes?.orderId ||
    prodigiRes?.data?.id ||
    null;

  await env.DB.prepare(`
    UPDATE orders
    SET prodigi_order_id = ?, status = ?
    WHERE id = ?
  `).bind(
    prodigiOrderId,
    "submitted_to_prodigi",
    orderId
  ).run();
}
