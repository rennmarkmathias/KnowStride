import Stripe from "stripe";
import { requireClerkAuth } from "./_auth";

export async function onRequestPost({ request, env }) {
  const auth = await requireClerkAuth(request, env);
  if (!auth) return json({ error: "Not logged in." }, 401);

  const body = await request.json().catch(() => null);
  const plan = (body?.plan || "").toLowerCase();

  const priceId = getPriceId(plan, env);
  if (!priceId) return json({ error: "Unknown plan." }, 400);

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });
  const origin = new URL(request.url).origin;

  const isSub = isRecurring(plan);

  const session = await stripe.checkout.sessions.create({
    mode: isSub ? "subscription" : "payment",
    line_items: [{ price: priceId, quantity: 1 }],

    // (Du ville ev. ta bort rabattkod-snack – då tar vi även bort allow_promotion_codes)
    // allow_promotion_codes: true,

    // Viktigt: efter success ska man INTE landa på checkout-läget igen
    success_url: `${origin}/app.html?success=1`,
    cancel_url: `${origin}/app.html?canceled=1&plan=${encodeURIComponent(plan)}`,

    metadata: { user_id: auth.userId, plan },

    // Kritisk för renewals: metadata på subscription-nivå också
    ...(isSub
      ? {
          subscription_data: {
            metadata: { user_id: auth.userId, plan },
          },
        }
      : {}),
  });

  return json({ url: session.url }, 200);
}

function isRecurring(plan) {
  return plan === "monthly" || plan === "yearly";
}

function getPriceId(plan, env) {
  const map = {
    monthly: env.PRICE_MONTHLY,
    yearly: env.PRICE_YEARLY,
    "3y": env.PRICE_3Y,
    "6y": env.PRICE_6Y,
    "9y": env.PRICE_9Y,
  };
  return map[plan];
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
