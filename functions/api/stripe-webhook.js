import Stripe from "stripe";

/**
 * Stripe webhook for Cloudflare Pages / Workers (NO Buffer usage)
 * Handles:
 * - checkout.session.completed
 * - invoice.payment_succeeded
 * - invoice.paid
 * - customer.subscription.deleted
 *
 * Writes:
 * - access(user_id, start_time, access_until, stripe_customer_id?, stripe_subscription_id?, plan?)
 * - purchases(id=event.id, user_id, stripe_event_id, stripe_session_id, plan, amount_total, currency, created_at)
 */

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response("Missing STRIPE_WEBHOOK_SECRET", { status: 500 });

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  const sig = request.headers.get("stripe-signature");
  if (!sig) return new Response("Missing stripe-signature", { status: 400 });

  // IMPORTANT: Use raw body EXACTLY (no JSON parsing)
  const rawBody = await request.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return new Response(`Webhook signature error: ${err?.message || String(err)}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(stripe, event, env);
        break;

      // Some accounts send one or the other depending on settings
      case "invoice.payment_succeeded":
      case "invoice.paid":
        await handleInvoicePaid(stripe, event, env);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event, env);
        break;

      default:
        // ignore
        break;
    }
  } catch (err) {
    return new Response(`Webhook handler error: ${err?.message || String(err)}`, { status: 500 });
  }

  return new Response("ok", { status: 200 });
}

/* ---------------- Handlers ---------------- */

async function handleCheckoutCompleted(stripe, event, env) {
  const session = event.data.object;

  const userId = session?.metadata?.user_id;
  const plan = (session?.metadata?.plan || "").toLowerCase();
  if (!userId || !plan) return;

  const nowMs = Date.now();

  // Compute initial access window
  const accessUntilMs = computeAccessUntilMs(plan, nowMs);

  // Optional: store these if columns exist (see SQL step below)
  const stripeCustomerId = session.customer || null;
  const stripeSubscriptionId = session.subscription || null;

  // 1) Upsert access
  // - keep earliest start_time if already present
  // - extend access_until if new is later
  // - store customer/subscription/plan if columns exist
  await upsertAccess(env, {
    userId,
    nowMs,
    accessUntilMs,
    stripeCustomerId,
    stripeSubscriptionId,
    plan,
  });

  // 2) Log purchase event idempotently (purchases.id = event.id)
  const amountTotal = typeof session.amount_total === "number" ? session.amount_total : null;
  const currency = session.currency || null;

  await env.DB.prepare(`
    INSERT INTO purchases (id, user_id, stripe_event_id, stripe_session_id, plan, amount_total, currency, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `)
    .bind(
      event.id,
      userId,
      event.id,
      session.id,
      plan,
      amountTotal,
      currency,
      nowMs
    )
    .run();
}

async function handleInvoicePaid(stripe, event, env) {
  const invoice = event.data.object;

  const subId = invoice.subscription || null;
  const customerId = invoice.customer || null;

  // If no subscription/customer, nothing to extend
  if (!subId && !customerId) return;

  // We prefer subscription-based lookup
  let row = null;

  // Requires columns to exist (see SQL step)
  if (subId) {
    row = await tryFindAccessBy(env, "stripe_subscription_id", subId);
  }
  if (!row && customerId) {
    row = await tryFindAccessBy(env, "stripe_customer_id", customerId);
  }
  if (!row) return; // can't map invoice -> user yet

  // Best source of truth: subscription current_period_end
  let newUntilMs = null;
  if (subId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subId);
      if (sub?.current_period_end) newUntilMs = sub.current_period_end * 1000;
    } catch {
      // ignore, fall back below
    }
  }

  // Fallback: invoice line period end
  if (!newUntilMs) {
    const line = invoice?.lines?.data?.[0];
    const periodEnd = line?.period?.end;
    if (periodEnd) newUntilMs = periodEnd * 1000;
  }

  if (!newUntilMs) return;

  // Update access_until only if later than existing
  await env.DB.prepare(`
    UPDATE access
    SET access_until = CASE
      WHEN access_until < ? THEN ?
      ELSE access_until
    END
    WHERE user_id = ?
  `).bind(newUntilMs, newUntilMs, row.user_id).run();
}

async function handleSubscriptionDeleted(event, env) {
  const sub = event.data.object;
  const subId = sub?.id;
  if (!subId) return;

  // Optional: clear stored subscription id / plan (if columns exist)
  // Do NOT reduce access_until — user keeps access until already paid end.
  await tryUpdateAccessOnCancel(env, subId);
}

/* ---------------- DB helpers ---------------- */

async function upsertAccess(env, { userId, nowMs, accessUntilMs, stripeCustomerId, stripeSubscriptionId, plan }) {
  // We don’t know if optional columns exist; try “extended” write first, else fallback to base schema.
  // Base schema: access(user_id, start_time, access_until)
  // Extended schema (recommended): + stripe_customer_id, stripe_subscription_id, plan

  // Attempt extended upsert
  try {
    await env.DB.prepare(`
      INSERT INTO access (user_id, start_time, access_until, stripe_customer_id, stripe_subscription_id, plan)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        start_time = CASE WHEN access.start_time < excluded.start_time THEN access.start_time ELSE excluded.start_time END,
        access_until = CASE WHEN access.access_until > excluded.access_until THEN access.access_until ELSE excluded.access_until END,
        stripe_customer_id = COALESCE(excluded.stripe_customer_id, access.stripe_customer_id),
        stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, access.stripe_subscription_id),
        plan = COALESCE(excluded.plan, access.plan)
    `).bind(userId, nowMs, accessUntilMs, stripeCustomerId, stripeSubscriptionId, plan).run();
    return;
  } catch {
    // fall back below
  }

  // Fallback (base schema)
  await env.DB.prepare(`
    INSERT INTO access (user_id, start_time, access_until)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      start_time = CASE WHEN access.start_time < excluded.start_time THEN access.start_time ELSE excluded.start_time END,
      access_until = CASE WHEN access.access_until > excluded.access_until THEN access.access_until ELSE excluded.access_until END
  `).bind(userId, nowMs, accessUntilMs).run();
}

async function tryFindAccessBy(env, col, val) {
  try {
    const q = `SELECT user_id, start_time, access_until FROM access WHERE ${col} = ? LIMIT 1`;
    return await env.DB.prepare(q).bind(val).first();
  } catch {
    return null;
  }
}

async function tryUpdateAccessOnCancel(env, subId) {
  try {
    await env.DB.prepare(`
      UPDATE access
      SET stripe_subscription_id = NULL, plan = NULL
      WHERE stripe_subscription_id = ?
    `).bind(subId).run();
  } catch {
    // ignore if columns don't exist
  }
}

/* ---------------- Plan durations ---------------- */

function computeAccessUntilMs(plan, nowMs) {
  const day = 24 * 60 * 60 * 1000;

  // recurring: set initial window; renewal extends via invoice events
  if (plan === "monthly") return nowMs + 31 * day;
  if (plan === "yearly") return nowMs + 366 * day;

  // one-time longer plans
  if (plan === "3y") return nowMs + 3 * 366 * day;
  if (plan === "6y") return nowMs + 6 * 366 * day;
  if (plan === "9y") return nowMs + 9 * 366 * day;

  return nowMs;
}
