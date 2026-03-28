import Stripe from 'stripe';
import { requireClerkAuth } from './_auth';

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const auth = await requireClerkAuth(request, env);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { userId, email } = auth;

    const body = await request.json();
    const { plan } = body || {};

    const plans = {
      solo_6m: { amount: 50, months: 6, seats: 1 },
      solo_12m: { amount: 7900, months: 12, seats: 1 },
      solo_36m: { amount: 14900, months: 36, seats: 1 },
      team_3: { amount: 24900, months: 12, seats: 3 },
      team_5: { amount: 39900, months: 12, seats: 5 },
      team_10: { amount: 69900, months: 12, seats: 10 }
    };

    const selected = plans[plan];
    if (!selected) {
      return new Response(JSON.stringify({ error: 'Invalid plan' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!env.STRIPE_SECRET_KEY) {
      throw new Error('Missing STRIPE_SECRET_KEY');
    }

    const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      apiVersion: '2023-10-16'
    });

    const origin = new URL(request.url).origin;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `BOLO License (${plan})`
            },
            unit_amount: selected.amount
          },
          quantity: 1
        }
      ],
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout.html?plan=${plan}`,
      metadata: {
        kind: 'bolo_license',
        plan,
        period_months: selected.months.toString(),
        seats: selected.seats.toString(),
        clerk_user_id: userId
      },
      invoice_creation: {
        enabled: true
      }
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('Checkout error:', err);

    return new Response(JSON.stringify({
      error: 'Server error',
      message: err?.message || String(err),
      type: err?.type || null,
      code: err?.code || null
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
