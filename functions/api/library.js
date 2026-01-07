import Stripe from "stripe";
import { requireClerkAuth } from "./_auth.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fetchAccess(env, userId) {
  const res = await env.DB.prepare(
    "SELECT user_id, start_time, access_until, plan, stripe_customer_id, stripe_subscription_id, status FROM access WHERE user_id = ?"
  )
    .bind(userId)
    .first();
  return res || null;
}

function isActive(accessRow) {
  if (!accessRow) return false;
  const until = Number(accessRow.access_until);
  return Number.isFinite(until) && until > Date.now() && (accessRow.status || "active") === "active";
}

// För att få “auto-unlock” utan refresh: om D1 saknar aktiv access,
// kolla Stripe efter en aktiv subscription kopplad till userId i metadata.
async function trySyncFromStripe(env, userId) {
  if (!env?.STRIPE_SECRET_KEY) return { synced: false };

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

  // Kräver Stripe Search API (subscriptions/search). Funkar bra för detta upplägg.
  const query = `metadata['user_id']:'${userId}' AND status:'active'`;
  const result = await stripe.subscriptions.search({ query, limit: 1 });

  const sub = result?.data?.[0];
  if (!sub) return { synced: false };

  const plan = sub?.metadata?.plan || "monthly";
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id || null;
  const subscriptionId = sub.id;
  const accessUntilMs = Number(sub.current_period_end) * 1000; // unix seconds -> ms

  if (!Number.isFinite(accessUntilMs)) return { synced: false };

  const nowMs = Date.now();

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

  return { synced: true, plan, accessUntil: accessUntilMs };
}

export async function onRequestGet(context) {
  try {
    const { env } = context;
    const { userId, email } = requireClerkAuth(context);

    // 1) Läs från D1
    let access = await fetchAccess(env, userId);
    if (isActive(access)) {
      return json({
        ok: true,
        loggedIn: true,
        userId,
        email,
        hasAccess: true,
        accessUntil: Number(access.access_until),
        plan: access.plan || null,
      });
    }

    // 2) Om ej aktiv: försök synka från Stripe (auto-unlock)
    const sync = await trySyncFromStripe(env, userId);
    if (sync.synced) {
      return json({
        ok: true,
        loggedIn: true,
        userId,
        email,
        hasAccess: true,
        accessUntil: sync.accessUntil,
        plan: sync.plan,
        syncedFromStripe: true,
      });
    }

    // 3) Annars: ingen access
    return json({
      ok: true,
      loggedIn: true,
      userId,
      email,
      hasAccess: false,
    });
  } catch (err) {
    return json({ ok: false, error: err?.message || String(err) }, 401);
  }
}
