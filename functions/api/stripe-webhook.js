import Stripe from "stripe";

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
