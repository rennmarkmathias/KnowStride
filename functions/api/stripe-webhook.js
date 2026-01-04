import Stripe from "stripe";

export async function onRequestPost({ request, env }) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  const sig = request.headers.get("stripe-signature");
  const rawBody = await request.arrayBuffer();

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      Buffer.from(rawBody),
      sig,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const userId = s.metadata?.user_id;
    const plan = s.metadata?.plan;

    if (userId && plan) {
      const now = Date.now();
      const accessUntil = computeAccessUntil(plan, now);

      // Upsert access: if first time, set start_time = now. If exists, keep existing start_time.
      const existing = await env.DB.prepare(
        "SELECT start_time FROM access WHERE user_id = ?"
      ).bind(userId).first();

      const startTime = existing?.start_time || now;

      await env.DB.prepare(
        "INSERT INTO access (user_id, start_time, access_until) VALUES (?, ?, ?) " +
        "ON CONFLICT(user_id) DO UPDATE SET access_until = excluded.access_until"
      ).bind(userId, startTime, accessUntil).run();

      // Log purchase
      await env.DB.prepare(
        "INSERT INTO purchases (id, user_id, stripe_event_id, stripe_session_id, plan, amount_total, currency, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        userId,
        event.id,
        s.id,
        plan,
        s.amount_total || null,
        s.currency || null,
        now
      ).run();
    }
  }

  return new Response("ok", { status: 200 });
}

function computeAccessUntil(plan, now) {
  const day = 24*60*60*1000;
  if (plan === "monthly") return now + 31*day;
  if (plan === "yearly") return now + 366*day;
  if (plan === "3y") return now + 3*366*day;
  if (plan === "6y") return now + 6*366*day;
  if (plan === "9y") return now + 9*366*day;
  return now;
}
