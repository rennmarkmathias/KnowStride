import Stripe from "stripe";

/**
 * Stripe webhook for Cloudflare Pages (Workers runtime)
 * - Uses constructEventAsync (required for SubtleCryptoProvider)
 * - No Buffer usage
 * - Persists access in D1 table: access
 */

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response("Missing STRIPE_WEBHOOK_SECRET", { status: 500 });
  if (!env.DB) return new Response("Missing DB binding", { status: 500 });

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  const sig = request.headers.get("stripe-signature");
  if (!sig) return new Response("Missing stripe-signature", { status: 400 });

  // Raw body (Workers-compatible)
  const raw = await request.arrayBuffer();
  const payload = new Uint8Array(raw);

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return new Response(`Webhook signature error: ${err?.message || err}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await onCheckoutSessionCompleted(stripe, event.data.object, env);
        break;

      case "invoice.payment_succeeded":
        await onInvoicePaymentSucceeded(stripe, event.data.object, env);
        break;

      case "customer.subscription.deleted":
        await onSubscriptionDeleted(event.data.object, env);
        break;

      default:
        // ignore other events
        break;
    }
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || err}`, { status: 500 });
  }

  return new Response("ok", { status: 200 });
}

/* ---------------- Business logic ---------------- */

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function addDaysUnix(baseUnix, days) {
  return baseUnix + days * 24 * 60 * 60;
}

function planToDays(plan) {
  switch ((plan || "").toLowerCase()) {
    case "monthly":
      return 31; // safe-ish buffer for months
    case "yearly":
      return 366;
    case "3y":
      return 366 * 3;
    case "6y":
      return 366 * 6;
    case "9y":
      return 366 * 9;
    default:
      return null;
  }
}

/**
 * Upsert access row.
 * - If first time: sets start_time = now
 * - Always sets/extends access_until
 */
async function upsertAccess(env, { userId, plan, stripeCustomerId, stripeSubscriptionId, newAccessUntil }) {
  const now = nowUnix();

  // We want "extend", not "shrink".
  const existing = await env.DB.prepare(
    `SELECT access_until, start_time FROM access WHERE user_id = ?`
  ).bind(userId).first();

  const startTime = existing?.start_time ?? now;
  const currentUntil = existing?.access_until ?? 0;
  const finalUntil = Math.max(currentUntil, newAccessUntil);

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
  // We rely on metadata from create-checkout-session.js
  const userId = session?.metadata?.user_id;
  const plan = session?.metadata?.plan;

  if (!userId || !plan) return;

  const days = planToDays(plan);
  if (!days) return;

  // For subscriptions, Stripe sets subscription & customer.
  const stripeCustomerId = session.customer || null;
  const stripeSubscriptionId = session.subscription || null;

  const until = addDaysUnix(nowUnix(), days);

  await upsertAccess(env, {
    userId,
    plan,
    stripeCustomerId,
    stripeSubscriptionId,
    newAccessUntil: until,
  });
}

async function onInvoicePaymentSucceeded(stripe, invoice, env) {
  // subscription renewals
  const subId = invoice?.subscription;
  if (!subId) return;

  // Fetch subscription to read metadata (plan/user_id)
  const sub = await stripe.subscriptions.retrieve(subId);
  const userId = sub?.metadata?.user_id;
  const plan = sub?.metadata?.plan;

  if (!userId || !plan) return;

  const days = planToDays(plan);
  if (!days) return;

  // Extend from "max(now, current_until)" inside upsertAccess
  const stripeCustomerId = sub.customer || null;
  const stripeSubscriptionId = sub.id;

  // We extend from now (upsertAccess handles max with existing)
  const until = addDaysUnix(nowUnix(), days);

  await upsertAccess(env, {
    userId,
    plan,
    stripeCustomerId,
    stripeSubscriptionId,
    newAccessUntil: until,
  });
}

async function onSubscriptionDeleted(subscription, env) {
  const subId = subscription?.id;
  if (!subId) return;

  // We do NOT remove access immediately. We just mark status canceled.
  await env.DB.prepare(`
    UPDATE access
    SET status = 'canceled'
    WHERE stripe_subscription_id = ?
  `).bind(subId).run();
}
