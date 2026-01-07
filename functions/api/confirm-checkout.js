import Stripe from 'stripe';
import { requireClerkAuth } from './_auth.js';

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

function computeAccessUntil(now, plan) {
  switch (plan) {
    case 'monthly':
      return addMonths(now, 1);
    case 'yearly':
      return addYears(now, 1);
    case '3y':
      return addYears(now, 3);
    case '6y':
      return addYears(now, 6);
    case '9y':
      return addYears(now, 9);
    default:
      return addMonths(now, 1);
  }
}

export async function onRequestGet({ request, env }) {
  // Must be logged in (prevents anyone from unlocking someone else's account).
  const auth = await requireClerkAuth(request, env);
  if (!auth?.userId) {
    return new Response(JSON.stringify({ ok: false, error: 'Not logged in' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing session_id' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid session_id' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Ensure the session belongs to this user.
  const metaUserId = session?.metadata?.user_id || session?.metadata?.clerk_user_id;
  if (!metaUserId || metaUserId !== auth.userId) {
    return new Response(JSON.stringify({ ok: false, error: 'Session does not match user' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  // For subscription checkouts, Stripe marks payment_status as "paid" when the first invoice is paid.
  if (session.payment_status !== 'paid') {
    return new Response(JSON.stringify({ ok: false, status: session.payment_status }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }

  const plan = session?.metadata?.plan || 'monthly';
  const now = new Date();
  const accessUntil = computeAccessUntil(now, plan);

  // Upsert access record
  await env.DB.prepare(
    `INSERT INTO access (user_id, start_time, access_until, plan, stripe_customer_id, stripe_subscription_id, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active')
     ON CONFLICT(user_id) DO UPDATE SET
       start_time=excluded.start_time,
       access_until=excluded.access_until,
       plan=excluded.plan,
       stripe_customer_id=excluded.stripe_customer_id,
       stripe_subscription_id=excluded.stripe_subscription_id,
       status='active'`
  )
    .bind(
      auth.userId,
      Math.floor(now.getTime() / 1000),
      Math.floor(accessUntil.getTime() / 1000),
      plan,
      session.customer || null,
      session.subscription || null
    )
    .run();

  return new Response(JSON.stringify({ ok: true, accessGranted: true, plan }), {
    headers: { 'content-type': 'application/json' },
  });
}
