import Stripe from 'stripe';
import { requireClerkAuth } from './_auth';

function isValidEmail(value) {
  const s = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function clampSeats(value) {
  const n = Math.floor(Number(value || 0));
  if (!Number.isFinite(n)) return 0;
  return Math.max(2, Math.min(30, n));
}

function teamDiscountFactor(seats) {
  const n = clampSeats(seats);
  if (n >= 20) return 0.68;  // 32% large school / organization discount
  if (n >= 10) return 0.812; // anchored close to current 10-user price
  if (n >= 5) return 0.946;  // anchored close to current 5-user price
  return 1.0;                // anchored close to current 3-user price
}

function roundMinorToWholeMajor(amountMinor) {
  return Math.max(100, Math.round(Number(amountMinor || 0) / 100) * 100);
}

function dynamicTeamPlan({ plan, seats }) {
  const key = String(plan || '').trim();
  const isSv = key.startsWith('sv_');
  const is36 = key.includes('36m');
  const n = clampSeats(seats);
  if (!n || n < 2 || n > 30) throw new Error('Team / School licenses require 2–30 seats.');

  const currency = isSv ? 'sek' : 'usd';
  const baseYearMinor = isSv ? 53900 : 5900; // current individual 12-month price
  const yearsCharged = is36 ? 2 : 1; // 36-month team offer: 3 years for the price of 2
  const months = is36 ? 36 : 12;
  const factor = teamDiscountFactor(n);
  const amount = roundMinorToWholeMajor(baseYearMinor * n * factor * yearsCharged);
  const prefix = isSv ? 'sv_' : '';
  return {
    amount,
    currency,
    months,
    seats: n,
    normalizedPlan: `${prefix}team_${n}_${months}m_dynamic`,
    displayName: isSv
      ? `BOLO Team / Skola — ${n} användare — ${months} månader`
      : `BOLO Team / School — ${n} users — ${months} months`,
  };
}

function resolvePlan(plan, seats) {
  const plans = {
    solo_6m: { amount: 3900, currency: 'usd', months: 6, seats: 1, normalizedPlan: 'solo_6m', displayName: 'BOLO Individual — 6 months' },
    solo_12m: { amount: 5900, currency: 'usd', months: 12, seats: 1, normalizedPlan: 'solo_12m', displayName: 'BOLO Individual — 12 months' },
    solo_36m: { amount: 12900, currency: 'usd', months: 36, seats: 1, normalizedPlan: 'solo_36m', displayName: 'BOLO Individual — 36 months' },

    // Legacy fixed plans kept for old links and invoices.
    team_3: { amount: 17900, currency: 'usd', months: 12, seats: 3, normalizedPlan: 'team_3', displayName: 'BOLO Team — 3 users — 12 months' },
    team_5: { amount: 27900, currency: 'usd', months: 12, seats: 5, normalizedPlan: 'team_5', displayName: 'BOLO Team — 5 users — 12 months' },
    team_10: { amount: 47900, currency: 'usd', months: 12, seats: 10, normalizedPlan: 'team_10', displayName: 'BOLO Team — 10 users — 12 months' },
    team_3_36m: { amount: 35800, currency: 'usd', months: 36, seats: 3, normalizedPlan: 'team_3_36m', displayName: 'BOLO Team — 3 users — 36 months' },
    team_5_36m: { amount: 55800, currency: 'usd', months: 36, seats: 5, normalizedPlan: 'team_5_36m', displayName: 'BOLO Team — 5 users — 36 months' },
    team_10_36m: { amount: 95800, currency: 'usd', months: 36, seats: 10, normalizedPlan: 'team_10_36m', displayName: 'BOLO Team — 10 users — 36 months' },

    sv_solo_6m: { amount: 35900, currency: 'sek', months: 6, seats: 1, normalizedPlan: 'sv_solo_6m', displayName: 'BOLO Individuell — 6 månader' },
    sv_solo_12m: { amount: 53900, currency: 'sek', months: 12, seats: 1, normalizedPlan: 'sv_solo_12m', displayName: 'BOLO Individuell — 12 månader' },
    sv_solo_36m: { amount: 117900, currency: 'sek', months: 36, seats: 1, normalizedPlan: 'sv_solo_36m', displayName: 'BOLO Individuell — 36 månader' },
    sv_team_3: { amount: 163900, currency: 'sek', months: 12, seats: 3, normalizedPlan: 'sv_team_3', displayName: 'BOLO Team — 3 användare — 12 månader' },
    sv_team_5: { amount: 254900, currency: 'sek', months: 12, seats: 5, normalizedPlan: 'sv_team_5', displayName: 'BOLO Team — 5 användare — 12 månader' },
    sv_team_10: { amount: 437900, currency: 'sek', months: 12, seats: 10, normalizedPlan: 'sv_team_10', displayName: 'BOLO Team — 10 användare — 12 månader' },
    sv_team_3_36m: { amount: 327900, currency: 'sek', months: 36, seats: 3, normalizedPlan: 'sv_team_3_36m', displayName: 'BOLO Team — 3 användare — 36 månader' },
    sv_team_5_36m: { amount: 509900, currency: 'sek', months: 36, seats: 5, normalizedPlan: 'sv_team_5_36m', displayName: 'BOLO Team — 5 användare — 36 månader' },
    sv_team_10_36m: { amount: 875900, currency: 'sek', months: 36, seats: 10, normalizedPlan: 'sv_team_10_36m', displayName: 'BOLO Team — 10 användare — 36 månader' },
  };

  if (plan === 'team_dynamic_12m' || plan === 'team_dynamic_36m' || plan === 'sv_team_dynamic_12m' || plan === 'sv_team_dynamic_36m') {
    return dynamicTeamPlan({ plan, seats });
  }

  const selected = plans[plan];
  if (!selected) throw new Error('Invalid plan');
  return selected;
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
    let selected;
    try {
      selected = resolvePlan(String(plan || ''), body?.seats);
    } catch (e) {
      return new Response(JSON.stringify({ error: e?.message || 'Invalid plan' }), {
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
    const checkoutPlan = selected.normalizedPlan || String(plan || 'licensed');

    const sessionPayload = {
      mode: 'payment',

      line_items: [
        {
          price_data: {
            currency: selected.currency || 'usd',
            product_data: {
              name: selected.displayName || `BOLO License (${checkoutPlan.replace(/^sv_/, '')})`
            },
            unit_amount: selected.amount
          },
          quantity: 1
        }
      ],

      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/checkout.html?plan=${encodeURIComponent(plan || checkoutPlan)}&seats=${encodeURIComponent(String(selected.seats || 1))}`,

      metadata: {
        kind: 'bolo_license',
        plan: checkoutPlan,
        original_plan: String(plan || ''),
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
      amount: selected.amount,
      currency: selected.currency,
      plan: checkoutPlan,
      seats: selected.seats,
      period_months: selected.months,
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
