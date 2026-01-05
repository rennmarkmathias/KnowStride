import Stripe from "stripe";

/**
 * Stripe webhook for Cloudflare Pages / Workers
 * - No Buffer usage (Buffer is not available)
 * - Handles:
 *   - checkout.session.completed
 *   - invoice.payment_succeeded
 *   - customer.subscription.deleted
 */

export async function onRequestPost({ request, env }) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2024-06-20",
  });

  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return new Response("Missing stripe-signature", { status: 400 });
  }

  // Read raw body as ArrayBuffer (Cloudflare-compatible)
  const rawBody = await request.arrayBuffer();
  const rawBodyBytes = new Uint8Array(rawBody);

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBodyBytes,
      sig,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return new Response(`Webhook signature error: ${err.message}`, {
      status: 400,
    });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object, env);
        break;

      case "invoice.payment_succeeded":
        await handleInvoicePaid(event.data.object, env);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionCanceled(event.data.object, env);
        break;
    }
  } catch (err) {
    return new Response(`Webhook handler error: ${err.message}`, {
      status: 500,
    });
  }

  return new Response("ok", { status: 200 });
}

/* ---------------- Handlers ---------------- */

async function handleCheckoutCompleted(session, env) {
  const userId = session.metadata?.user_id;
  const plan = session.metadata?.plan;
  if (!userId || !plan) return;

  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO subscriptions (user_id, plan, started_at, status)
    VALUES (?, ?, ?, 'active')
    ON CONFLICT(user_id) DO UPDATE SET
      plan = excluded.plan,
      status = 'active'
  `).bind(userId, plan, now).run();
}

async function handleInvoicePaid(invoice, env) {
  const subscriptionId = invoice.subscription;
  if (!subscriptionId) return;

  // Keep subscription active
  await env.DB.prepare(`
    UPDATE subscriptions
    SET status = 'active'
    WHERE stripe_subscription_id = ?
  `).bind(subscriptionId).run();
}

async function handleSubscriptionCanceled(subscription, env) {
  await env.DB.prepare(`
    UPDATE subscriptions
    SET status = 'canceled'
    WHERE stripe_subscription_id = ?
  `).bind(subscription.id).run();
}
