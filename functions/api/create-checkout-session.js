import Stripe from "stripe";
import { requireClerkAuth } from "./_auth";

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    const auth = await requireClerkAuth(request, env);
    if (!auth) return new Response("Unauthorized", { status: 401 });

    const { userId } = auth;

    const stripeKey = env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });
    }

    const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });

    const { plan } = await request.json();

    // Only 3 plans + new Stripe Price IDs
    const priceMap = {
      monthly: "price_1SojhyBGIoJDnx09wsl1Bc3W",
      yearly: "price_1SojlSBGIoJDnx09SJEFYE0d",
      "3y":   "price_1SojpGBGIoJDnx09PFoceWJv",
    };

    const price = priceMap[plan];
    if (!price) return new Response("Invalid plan", { status: 400 });

    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;

    // Stripe must be allowed to inject the session_id token
    const successUrl = `${origin}/app?success=1&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/app?canceled=1`;

    const isOneTime = plan === "3y";

    const session = await stripe.checkout.sessions.create({
      mode: isOneTime ? "payment" : "subscription",
      line_items: [{ price, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,

      client_reference_id: userId,

      metadata: {
        user_id: userId,
        plan,
      },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err?.message || String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
