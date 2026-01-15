import Stripe from "stripe";
import { requireClerkAuth } from "./_auth";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Creates a Stripe Billing Portal session so customers can cancel/manage
// their subscription themselves.
export async function onRequestPost({ request, env }) {
  try {
    const auth = await requireClerkAuth(request, env);
    if (!auth) return new Response("Unauthorized", { status: 401 });

    const userId = auth.userId;

    const stripeKey = env.STRIPE_SECRET_KEY;
    if (!stripeKey) return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });

    if (!env.DB) return new Response("Missing DB binding", { status: 500 });

    // Look up Stripe customer id for this user
    const row = await env.DB.prepare(
      `SELECT stripe_customer_id
       FROM access
       WHERE user_id = ?1
       ORDER BY access_until DESC
       LIMIT 1`
    )
      .bind(userId)
      .first();

    const customer = row?.stripe_customer_id || null;
    if (!customer) {
      return json(
        {
          error:
            "No Stripe customer found for this account yet. If you just purchased, please wait a moment and refresh.",
        },
        400
      );
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });

    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;
    const returnUrl = `${origin}/app`;

    const session = await stripe.billingPortal.sessions.create({
      customer,
      return_url: returnUrl,
    });

    return json({ url: session.url });
  } catch (err) {
    return json({ error: err?.message || String(err) }, 500);
  }
}
