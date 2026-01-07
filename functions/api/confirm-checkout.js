import Stripe from "stripe";
import { requireClerkAuth } from "./_auth";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestGet({ request, env }) {
  try {
    const auth = await requireClerkAuth(request, env);
    const userId = auth.userId;

    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session_id");

    if (!sessionId) return json({ error: "Missing session_id" }, 400);

    const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
    });

    // Fetch the checkout session and subscription
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Basic safety: make sure session belongs to this logged-in user
    const ref = session.client_reference_id;
    const metaUser = session.metadata?.user_id;

    if (ref && ref !== userId && metaUser && metaUser !== userId) {
      return json({ error: "Session does not belong to this user" }, 403);
    }

    // If Stripe hasn't completed it yet, tell frontend to keep polling
    const paid =
      session.payment_status === "paid" ||
      session.status === "complete" ||
      session.status === "completed";

    if (!paid) {
      return json({ ok: true, accessGranted: false, pending: true });
    }

    // Determine access_until from subscription period end if possible
    let accessUntil = Math.floor(Date.now() / 1000) + 60 * 60; // fallback +1h

    if (session.subscription) {
      const subId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription.id;

      const sub = await stripe.subscriptions.retrieve(subId);
      if (sub?.current_period_end) accessUntil = Number(sub.current_period_end);
    }

    const updatedAt = Math.floor(Date.now() / 1000);

    // Upsert into D1 (same style as webhook)
    await env.DB.prepare(
      `INSERT INTO access (user_id, active, access_until, updated_at)
       VALUES (?1, 1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET
         active=1,
         access_until=?2,
         updated_at=?3`
    )
      .bind(userId, accessUntil, updatedAt)
      .run();

    return json({ ok: true, accessGranted: true, accessUntil });
  } catch (err) {
    const msg = err?.message || String(err);
    const status = msg.toLowerCase().includes("unauthorized") ? 401 : 500;
    return json({ error: msg }, status);
  }
}
