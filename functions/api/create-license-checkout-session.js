import Stripe from 'stripe';
import { requireClerkAuth } from './_auth';

function isValidEmail(value) {
  const s = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const auth = await requireClerkAuth(request, env);

    if (!auth || !auth.ok) {
      return new Response(JSON.stringify({
        error: 'Unauthorized',
        message: auth?.error || 'Clerk auth failed or returned null'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const { userId, email } = auth;

    const body = await request.json();
    const { plan } = body || {};

    const plans = {
      solo_6m: { amount: 3900, months: 6, seats: 1 },
      solo_12m: { amount: 5900, months: 12, seats: 1 },
      solo_36m: { amount: 70, months: 36, seats: 1 },
      team_3: { amount: 17900, months: 12, seats: 3 },
      team_5: { amount: 27900, months: 12, seats: 5 },
      team_10: { amount: 47900, months: 12, seats: 10 },
      team_3_36m: { amount: 35800, months: 36, seats: 3 },
      team_5_36m: { amount: 55800, months: 36, seats: 5 },
      team_10_36m: { amount: 70, months: 36, seats: 10 }
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

    const sessionPayload = {
      mode: 'payment',

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
    };

    if (isValidEmail(email)) {
      sessionPayload.customer_email = String(email).trim();
    }

    const session = await stripe.checkout.sessions.create(sessionPayload);

    return new Response(JSON.stringify({
      url: session.url,
      debug_email_used: isValidEmail(email) ? String(email).trim() : null
    }), {
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
