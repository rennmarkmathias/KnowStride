import Stripe from "stripe";
import { findPosterById } from "./_posters";
import { createProdigiOrder, prodigiSkuFor } from "./_prodigi";

export async function onRequestPost({ request, env }) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  const sig = request.headers.get("stripe-signature");
  if (!sig) return new Response("Missing stripe-signature", { status: 400 });

  const rawBody = await request.arrayBuffer();
  const rawBodyBytes = new Uint8Array(rawBody);

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBodyBytes,
      sig,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return new Response(`Webhook signature error: ${err?.message || err}`, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      await onCheckoutSessionCompleted(stripe, event.data.object, env);
    } else if (event.type === "invoice.payment_succeeded") {
      await onInvoicePaymentSucceeded(stripe, event.data.object, env);
    } else if (event.type === "customer.subscription.deleted") {
      await onSubscriptionDeleted(event.data.object, env);
    }
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || err}`, { status: 500 });
  }

  return new Response("ok", { status: 200 });
}

/* ---------------- Access helpers ---------------- */

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function addDaysUnix(unixSeconds, days) {
  return unixSeconds + days * 24 * 60 * 60;
}

function planToDays(plan) {
  const p = (plan || "").toLowerCase();
  if (p === "monthly") return 30;
  if (p === "yearly") return 365;
  if (p === "3y") return 365 * 3;
  if (p === "6y") return 365 * 6;
  if (p === "9y") return 365 * 9;
  return 0;
}

async function upsertAccess(env, { userId, plan, stripeCustomerId, stripeSubscriptionId, newAccessUntil }) {
  const nowMs = Date.now();

  const existing = await env.DB.prepare(
    "SELECT access_until, start_time FROM access WHERE user_id = ?"
  ).bind(userId).first();

  const startTime = existing?.start_time ?? nowMs;
  const currentUntil = Number(existing?.access_until ?? 0);
  const finalUntil = Math.max(currentUntil, newAccessUntil * 1000); // access_until lagras i ms hos dig

  await env.DB.prepare(`
    INSERT INTO access (user_id, start_time, access_until, plan, stripe_customer_id, stripe_subscription_id, status)
    VALUES (?, ?, ?, ?, ?, ?, 'active')
    ON CONFLICT(user_id) DO UPDATE SET
      access_until = excluded.access_until,
      plan = excluded.plan,
      stripe_customer_id = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      status = 'active'
  `).bind(
    userId,
    startTime,
    finalUntil,
    plan || null,
    stripeCustomerId || null,
    stripeSubscriptionId || null
  ).run();
}

async function onCheckoutSessionCompleted(stripe, session, env) {
  // Route: poster shop checkout vs existing access/subscription checkout.
  if (session?.metadata?.kind === "poster" || session?.metadata?.poster_id) {
    await onPosterCheckoutSessionCompleted(stripe, session, env);
    return;
  }

  const userId = session?.metadata?.user_id;
  const plan = session?.metadata?.plan;
  if (!userId || !plan) return;

  const days = planToDays(plan);
  if (!days) return;

  const stripeCustomerId = session.customer || null;
  const stripeSubscriptionId = session.subscription || null;

  const untilUnix = addDaysUnix(nowUnix(), days);

  await upsertAccess(env, {
    userId,
    plan,
    stripeCustomerId,
    stripeSubscriptionId,
    newAccessUntil: untilUnix,
  });
}

/* ---------------- Poster order flow (Stripe -> DB -> Prodigi) ---------------- */

async function onPosterCheckoutSessionCompleted(stripe, session, env) {
  if (!env.DB) throw new Error("Missing DB binding");

  // Retrieve a full session to be safe (address + customer details).
  const full = await stripe.checkout.sessions.retrieve(session.id, {
    expand: ["customer_details", "shipping_details"],
  });

  // Minimal guards
  if (full.payment_status !== "paid") return;

  const md = full.metadata || {};
  const posterId = md.poster_id;
  const paper = md.paper;
  const size = md.size;
  const mode = md.mode || "STRICT";
  const printUrl = md.print_url;
  if (!posterId || !paper || !size || !printUrl) {
    throw new Error("Missing poster metadata on Stripe session");
  }

  const poster = await findPosterById(new Request(full.success_url || "https://example.com"), env, posterId);
  const posterTitle = md.poster_title || poster?.title || posterId;

  const orderId = crypto.randomUUID();
  const email = full.customer_details?.email || null;
  const clerkUserId = md.clerk_user_id || null;
  const amountTotal = full.amount_total != null ? Number(full.amount_total) / 100 : null;
  const currency = (full.currency || "usd").toLowerCase();

  // Idempotency: if Stripe retries this webhook, don't create duplicates.
  const existing = await env.DB.prepare(`SELECT id FROM orders WHERE stripe_session_id = ? LIMIT 1`)
    .bind(full.id)
    .first();
  if (existing?.id) return;

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

  // Build Prodigi payload
  const sku = prodigiSkuFor(env, paper, size);
  if (!sku) {
    await env.DB.prepare(`UPDATE orders SET status=? WHERE id=?`).bind("paid_missing_prodigi_sku", orderId).run();
    throw new Error(
      `Missing Prodigi SKU mapping. Set env var PRODIGI_SKU_${paper === "fineart" ? "FAP" : "BLP"}_${String(size).replace(/[^a-z0-9]/gi, "").toUpperCase()}`
    );
  }

  const ship = full.shipping_details;
  const addr = ship?.address || full.customer_details?.address || {};

  const payload = {
    merchantReference: orderId,
    shippingMethod: env.PRODIGI_SHIPPING_METHOD || "Budget",
    recipient: {
      name: ship?.name || full.customer_details?.name || "Customer",
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
        sizing: "fillPrintArea",
        assets: [
          {
            printArea: "default",
            url: printUrl,
          },
        ],
      },
    ],
  };

  let prodigiOrderId = null;
  try {
    const resp = await createProdigiOrder(env, payload);
    prodigiOrderId = resp?.id || resp?.orderId || null;
  } catch (err) {
    await env.DB.prepare(`UPDATE orders SET status=? WHERE id=?`).bind("paid_prodigi_failed", orderId).run();
    throw err;
  }

  await env.DB.prepare(`UPDATE orders SET prodigi_order_id=?, status=? WHERE id=?`)
    .bind(prodigiOrderId, "sent_to_prodigi", orderId)
    .run();
}

async function onInvoicePaymentSucceeded(stripe, invoice, env) {
  const subId = invoice?.subscription;
  if (!subId) return;

  const sub = await stripe.subscriptions.retrieve(subId);
  const userId = sub?.metadata?.user_id;
  const plan = sub?.metadata?.plan;
  if (!userId || !plan) return;

  const days = planToDays(plan);
  if (!days) return;

  const untilUnix = addDaysUnix(nowUnix(), days);

  await upsertAccess(env, {
    userId,
    plan,
    stripeCustomerId: sub.customer || null,
    stripeSubscriptionId: sub.id,
    newAccessUntil: untilUnix,
  });
}

async function onSubscriptionDeleted(subscription, env) {
  const subId = subscription?.id;
  if (!subId) return;

  await env.DB.prepare(`
    UPDATE access
    SET status = 'canceled'
    WHERE stripe_subscription_id = ?
  `).bind(subId).run();
}
