import Stripe from "stripe";

export async function onRequestPost({ request, env }) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  const sig = request.headers.get("stripe-signature");
  const rawBody = await request.arrayBuffer();

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      Buffer.from(rawBody),
      sig,
      env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutSessionCompleted(stripe, env, event);
        break;

      case "invoice.paid":
        await handleInvoicePaid(stripe, env, event);
        break;

      case "customer.subscription.updated":
        await handleSubscriptionUpdated(env, event);
        break;

      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(env, event);
        break;

      default:
        break;
    }
  } catch (e) {
    // Returnera 200 ändå? Nej: bättre att få retries tills det funkar.
    return new Response(`Webhook handler failed: ${e?.message || e}`, { status: 500 });
  }

  return new Response("ok", { status: 200 });
}

/* ---------------- Handlers ---------------- */

async function handleCheckoutSessionCompleted(stripe, env, event) {
  const s = event.data.object; // Checkout Session
  const userId = s.metadata?.user_id;
  const plan = s.metadata?.plan;

  if (!userId || !plan) return;

  const now = Date.now();

  // accessUntil:
  // - subscription: använd subscription.current_period_end
  // - one-time: computeAccessUntil(plan)
  let accessUntil = computeAccessUntil(plan, now);

  if (s.mode === "subscription" && s.subscription) {
    const sub = await stripe.subscriptions.retrieve(s.subscription);
    // current_period_end är i sekunder
    accessUntil = Number(sub.current_period_end) * 1000;

    // säkerställ metadata även om något varit tomt
    const metaUser = sub.metadata?.user_id || userId;
    const metaPlan = sub.metadata?.plan || plan;

    await upsertAccess(env, metaUser, now, accessUntil);

    await logPurchase(env, {
      userId: metaUser,
      stripeEventId: event.id,
      stripeSessionId: s.id,
      plan: metaPlan,
      amountTotal: s.amount_total ?? null,
      currency: s.currency ?? null,
      createdAt: now,
    });

    return;
  }

  await upsertAccess(env, userId, now, accessUntil);

  await logPurchase(env, {
    userId,
    stripeEventId: event.id,
    stripeSessionId: s.id,
    plan,
    amountTotal: s.amount_total ?? null,
    currency: s.currency ?? null,
    createdAt: now,
  });
}

async function handleInvoicePaid(stripe, env, event) {
  const inv = event.data.object; // Invoice

  // Bara relevant om invoice hör till en subscription
  if (!inv.subscription) return;

  const subId = typeof inv.subscription === "string" ? inv.subscription : inv.subscription.id;
  const sub = await stripe.subscriptions.retrieve(subId);

  const userId = sub.metadata?.user_id;
  const plan = sub.metadata?.plan || "monthly";

  if (!userId) return;

  const now = Date.now();
  const accessUntil = Number(sub.current_period_end) * 1000;

  await upsertAccess(env, userId, now, accessUntil);

  // (Valfritt) logga invoice som purchase-variant genom att använda invoice.id som “session”
  await logPurchase(env, {
    userId,
    stripeEventId: event.id,
    stripeSessionId: `invoice:${inv.id}`,
    plan,
    amountTotal: inv.amount_paid ?? null,
    currency: inv.currency ?? null,
    createdAt: now,
  });
}

async function handleSubscriptionUpdated(env, event) {
  const sub = event.data.object;
  const userId = sub.metadata?.user_id;
  if (!userId) return;

  // Om cancel_at_period_end: håll access till periodens slut (period_end)
  // Om subscription blivit “paused” etc kan du senare justera – men detta är safe default.
  const periodEndMs = Number(sub.current_period_end) * 1000;
  const now = Date.now();

  await upsertAccess(env, userId, now, periodEndMs);
}

async function handleSubscriptionDeleted(env, event) {
  const sub = event.data.object;
  const userId = sub.metadata?.user_id;
  if (!userId) return;

  // När deleted: access fram till current_period_end (Stripe brukar fortfarande ha det)
  const periodEndMs = Number(sub.current_period_end) * 1000;
  const now = Date.now();

  await upsertAccess(env, userId, now, periodEndMs);
}

/* ---------------- DB helpers ---------------- */

async function upsertAccess(env, userId, now, accessUntil) {
  const existing = await env.DB.prepare(
    "SELECT start_time, access_until FROM access WHERE user_id = ?"
  ).bind(userId).first();

  const startTime = existing?.start_time || now;

  // Access should never shrink by mistake: keep the MAX
  await env.DB.prepare(
    "INSERT INTO access (user_id, start_time, access_until) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET " +
      "start_time = access.start_time, " +
      "access_until = CASE WHEN excluded.access_until > access.access_until THEN excluded.access_until ELSE access.access_until END"
  ).bind(userId, startTime, accessUntil).run();
}

async function logPurchase(env, row) {
  // Om du kör flera event retries så vill du helst ha UNIQUE på stripe_event_id.
  // (Se SQL-migrationen längre ner.)
  await env.DB.prepare(
    "INSERT INTO purchases (id, user_id, stripe_event_id, stripe_session_id, plan, amount_total, currency, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    crypto.randomUUID(),
    row.userId,
    row.stripeEventId,
    row.stripeSessionId,
    row.plan,
    row.amountTotal,
    row.currency,
    row.createdAt
  ).run();
}

function computeAccessUntil(plan, now) {
  const day = 24 * 60 * 60 * 1000;
  if (plan === "monthly") return now + 31 * day;
  if (plan === "yearly") return now + 366 * day;
  if (plan === "3y") return now + 3 * 366 * day;
  if (plan === "6y") return now + 6 * 366 * day;
  if (plan === "9y") return now + 9 * 366 * day;
  return now;
}
