import Stripe from "stripe";
import { requireClerkAuth } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function assertEnv(env, key) {
  if (!env?.[key]) throw new Error(`Missing env var: ${key}`);
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}
function addYears(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

// Fallback om vi inte kan läsa Stripe current_period_end (borde sällan hända)
function computeAccessUntilMs(nowMs, plan) {
  const now = new Date(nowMs);
  switch (plan) {
    case "monthly":
      return addMonths(now, 1).getTime();
    case "yearly":
      return addYears(now, 1).getTime();
    case "3y":
      return addYears(now, 3).getTime();
    case "6y":
      return addYears(now, 6).getTime();
    case "9y":
      return addYears(now, 9).getTime();
    default:
      return addMonths(now, 1).getTime();
  }
}

async function getCheckoutSession(stripe, sessionId) {
  return await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["subscription"],
  });
}

async function getSubscription(stripe, maybeSub) {
  if (!maybeSub) return null;
  if (typeof maybeSub === "object" && maybeSub.id) return maybeSub;
  if (typeof maybeSub === "string") return await stripe.subscriptions.retrieve(maybeSub);
  return null;
}

/**
 * Kallas från client efter retur från Stripe:
 *   /app?success=1&session_id=cs_...
 */
export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    assertEnv(env, "STRIPE_SECRET_KEY");

    const { userId } = requireClerkAuth(context);

    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session_id");
    if (!sessionId) return json({ ok: false, error: "Missing session_id" }, 400);

    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

    const session = await getCheckoutSession(stripe, sessionId);

    if (session.payment_status !== "paid") {
      return json(
        { ok: false, error: `Checkout session not paid (status=${session.payment_status})` },
        400
      );
    }

    const plan =
      session?.metadata?.plan ||
      session?.subscription?.metadata?.plan ||
      "monthly";

    const customerId =
      typeof session.customer === "string" ? session.customer : session.customer?.id || null;

    const subscriptionObj = await getSubscription(stripe, session.subscription);
    const subscriptionId =
      subscriptionObj?.id || (typeof session.subscription === "string" ? session.subscription : null);

    const nowMs = Date.now();

    // Stripe är “source of truth” (period slut)
    let accessUntilMs = null;
    if (subscriptionObj?.current_period_end) {
      accessUntilMs = Number(subscriptionObj.current_period_end) * 1000;
    }
    if (!accessUntilMs || !Number.isFinite(accessUntilMs)) {
      accessUntilMs = computeAccessUntilMs(nowMs, plan);
    }

    await env.DB.prepare(
      `
      INSERT INTO access (user_id, start_time, access_until, plan, stripe_customer_id, stripe_subscription_id, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
      ON CONFLICT(user_id) DO UPDATE SET
        start_time=excluded.start_time,
        access_until=excluded.access_until,
        plan=excluded.plan,
        stripe_customer_id=excluded.stripe_customer_id,
        stripe_subscription_id=excluded.stripe_subscription_id,
        status='active'
      `
    )
      .bind(userId, nowMs, accessUntilMs, plan, customerId, subscriptionId)
      .run();

    return json({ ok: true, userId, plan, accessUntil: accessUntilMs });
  } catch (err) {
    return json({ ok: false, error: err?.message || String(err) }, 500);
  }
}
