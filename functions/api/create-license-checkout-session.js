import Stripe from "stripe";
import { requireClerkAuth } from "./_auth.js";

const PLAN_CONFIG = {
  solo_6m:  { name: "BOLO Individual 6 months", priceEnv: "STRIPE_PRICE_SOLO_6M", seats: 1, periodMonths: 6 },
  solo_12m: { name: "BOLO Individual 12 months", priceEnv: "STRIPE_PRICE_SOLO_12M", seats: 1, periodMonths: 12 },
  solo_36m: { name: "BOLO Individual 36 months", priceEnv: "STRIPE_PRICE_SOLO_36M", seats: 1, periodMonths: 36 },
  team_3:   { name: "BOLO Team 3 users",         priceEnv: "STRIPE_PRICE_TEAM_3",  seats: 3, periodMonths: 12 },
  team_5:   { name: "BOLO Team 5 users",         priceEnv: "STRIPE_PRICE_TEAM_5",  seats: 5, periodMonths: 12 },
  team_10:  { name: "BOLO Team 10 users",        priceEnv: "STRIPE_PRICE_TEAM_10", seats: 10, periodMonths: 12 },
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  try {
    const auth = await requireClerkAuth(request, env);
    const clerkUserId = auth?.userId || null;
    const email = auth?.claims?.email || auth?.claims?.email_address || null;

    if (!clerkUserId) {
      return json({ error: "Not authenticated." }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const planKey = String(body?.plan || "").trim();
    const plan = PLAN_CONFIG[planKey];

    if (!plan) {
      return json({ error: "Invalid plan." }, { status: 400 });
    }

    if (!env.STRIPE_SECRET_KEY) {
      return json({ error: "Missing STRIPE_SECRET_KEY." }, { status: 500 });
    }

    const priceId = env[plan.priceEnv];
    if (!priceId) {
      return json({ error: `Missing price env var: ${plan.priceEnv}` }, { status: 500 });
    }

    const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: "2024-06-20",
      httpClient: Stripe.createFetchHttpClient(),
    });

    const origin = new URL(request.url).origin;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout.html?plan=${encodeURIComponent(planKey)}`,
      allow_promotion_codes: true,
      automatic_tax: { enabled: true },
      billing_address_collection: "required",
      customer_email: email || undefined,
      metadata: {
        kind: "bolo_license",
        product: "bolo",
        plan: planKey,
        seats: String(plan.seats),
        period_months: String(plan.periodMonths),
        clerk_user_id: clerkUserId,
      },
      invoice_creation: { enabled: true },
      consent_collection: { terms_of_service: "required" },
      custom_text: {
        terms_of_service_acceptance: {
          message: "By completing your purchase, you agree to the BOLO license terms. Refund requests are handled manually by support.",
        },
      },
    });

    return json({ url: session.url });
  } catch (err) {
    return json({ error: err?.message || String(err) }, { status: 500 });
  }
}
