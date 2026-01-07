import Stripe from "stripe";
import { requireClerkAuth } from "./_auth";

export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    const auth = await requireClerkAuth(request, env);
    if (!auth) return new Response("Unauthorized", { status: 401 });

    const { userId } = auth;

    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session_id");
    if (!sessionId) return new Response("Missing session_id", { status: 400 });

    const stripeKey = env.STRIPE_SECRET_KEY;
    if (!stripeKey) return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    if (session.payment_status !== "paid") {
      return new Response(JSON.stringify({ ok: false, reason: "not_paid" }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      });
    }

    const metaUserId = session?.metadata?.user_id;
    if (!metaUserId) return new Response("Missing user_id in session metadata", { status: 400 });
    if (metaUserId !== userId) return new Response("Forbidden", { status: 403 });

    const subscription = session.subscription;
    if (!subscription || typeof subscription !== "object") {
      return new Response("Missing subscription on session", { status: 400 });
    }

    const plan = session?.metadata?.plan || "monthly";

    // Stripe ger seconds, vi sparar ms
    const start_time = Date.now();
    const access_until = (subscription.current_period_end || 0) * 1000;

    if (!access_until) {
      return new Response("Missing subscription current_period_end", { status: 400 });
    }

    const db = env.DB;
    if (!db) return new Response("Missing DB binding", { status: 500 });

    const stripe_customer_id = session.customer || null;
    const stripe_subscription_id = subscription.id || null;

    await db.prepare(
      `INSERT INTO access (user_id, start_time, access_until, plan, stripe_customer_id, stripe_subscription_id, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')
       ON CONFLICT(user_id) DO UPDATE SET
         start_time=excluded.start_time,
         access_until=excluded.access_until,
         plan=excluded.plan,
         stripe_customer_id=excluded.stripe_customer_id,
         stripe_subscription_id=excluded.stripe_subscription_id,
         status='active'`
    )
    .bind(
      userId,
      start_time,
      access_until,
      plan,
      stripe_customer_id,
      stripe_subscription_id
    )
    .run();

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err?.message || String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
