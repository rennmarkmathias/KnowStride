import Stripe from "stripe";
import { generateLicenseRecord } from "./_licenses.js";
import { sendLicenseIssuedEmail } from "./_mail.js";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function asText(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function planLabel(plan) {
  const key = String(plan || "").trim();
  const labels = {
    solo_6m: "BOLO Individual — 6 months",
    solo_12m: "BOLO Individual — 12 months",
    solo_36m: "BOLO Individual — 36 months",
    team_3: "BOLO Team — 3 users — 12 months",
    team_5: "BOLO Team — 5 users — 12 months",
    team_10: "BOLO Team — 10 users — 12 months",
    team_3_36m: "BOLO Team — 3 users — 36 months",
    team_5_36m: "BOLO Team — 5 users — 36 months",
    team_10_36m: "BOLO Team — 10 users — 36 months",
    sv_solo_6m: "BOLO Individual — 6 months",
    sv_solo_12m: "BOLO Individual — 12 months",
    sv_solo_36m: "BOLO Individual — 36 months",
    sv_team_3: "BOLO Team — 3 users — 12 months",
    sv_team_5: "BOLO Team — 5 users — 12 months",
    sv_team_10: "BOLO Team — 10 users — 12 months",
    sv_team_3_36m: "BOLO Team — 3 users — 36 months",
    sv_team_5_36m: "BOLO Team — 5 users — 36 months",
    sv_team_10_36m: "BOLO Team — 10 users — 36 months",
  };
  return labels[key] || key || "BOLO License";
}

async function alreadyProcessed(env, stripeSessionId) {
  if (!env.DB) return false;
  const row = await env.DB.prepare(
    `SELECT id FROM licenses WHERE stripe_session_id = ? LIMIT 1`
  ).bind(stripeSessionId).first();
  return Boolean(row?.id);
}

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    return new Response("Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET", { status: 500 });
  }
  if (!env.DB) {
    return new Response("Missing DB binding", { status: 500 });
  }
  if (!env.LICENSE_SECRET) {
    return new Response("Missing LICENSE_SECRET", { status: 500 });
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: "2024-06-20",
    httpClient: Stripe.createFetchHttpClient(),
  });

  const sig = request.headers.get("stripe-signature");
  const body = await request.text();

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return new Response(`Webhook signature verification failed: ${err?.message || String(err)}`, { status: 400 });
  }

  if (event.type !== "checkout.session.completed") {
    return new Response("ok", { status: 200 });
  }

  const sessionId = event.data.object?.id;
  if (!sessionId) {
    return new Response("Missing session id", { status: 400 });
  }

  if (await alreadyProcessed(env, sessionId)) {
    return new Response("ok", { status: 200 });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["customer_details", "payment_intent", "invoice"],
    });

    if (session.metadata?.kind !== "bolo_license") {
      return new Response("ok", { status: 200 });
    }

    const plan = asText(session.metadata?.plan) || "licensed";
    const seats = Number(session.metadata?.seats || 1);
    const periodMonths = Number(session.metadata?.period_months || 12);
    const clerkUserId = asText(session.metadata?.clerk_user_id) || null;
    const email =
      asText(session.customer_details?.email) ||
      asText(session.customer_email) ||
      asText(session.metadata?.email) ||
      null;

    if (!email && !clerkUserId) {
      throw new Error("Missing purchaser identity on session metadata");
    }

    const issuedAt = new Date();
    const license = await generateLicenseRecord({
      secret: env.LICENSE_SECRET,
      plan,
      periodMonths,
      seats,
      clerkUserId,
      email,
      issuedAt,
    });

    const invoiceObj = typeof session.invoice === "object" ? session.invoice : null;
    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : asText(session.payment_intent?.id) || null;

    await env.DB.prepare(
      `INSERT INTO licenses (
        created_at, updated_at, email, clerk_user_id,
        license_key, license_fingerprint, plan, period_months, seats,
        status, issued_at, expires_at,
        stripe_session_id, stripe_payment_intent_id, stripe_invoice_id, stripe_invoice_url
      ) VALUES (
        datetime('now'), datetime('now'), ?, ?,
        ?, ?, ?, ?, ?,
        'active', ?, ?,
        ?, ?, ?, ?
      )`
    ).bind(
      email,
      clerkUserId,
      license.licenseKey,
      license.licenseFingerprint,
      license.plan,
      license.periodMonths,
      license.seats,
      license.issuedAt,
      license.expiresAt,
      session.id,
      paymentIntentId,
      asText(invoiceObj?.id) || null,
      asText(invoiceObj?.hosted_invoice_url) || null,
    ).run();

    await env.DB.prepare(
      `INSERT INTO purchases (
        user_id, stripe_event_id, stripe_session_id, plan, amount_total, currency, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      clerkUserId || email || "guest",
      event.id,
      session.id,
      license.plan,
      Number(session.amount_total || 0),
      asText(session.currency) || "usd",
      Math.floor(Date.now() / 1000),
    ).run().catch(() => null);

    const origin = new URL(request.url).origin;
    await sendLicenseIssuedEmail(env, {
      to: email,
      email,
      plan: planLabel(plan),
      seats,
      expiresAt: license.expiresAt,
      licenseKey: license.licenseKey,
      accountUrl: `${origin}/account.html`,
    }).catch(() => null);

    return json({ ok: true });
  } catch (err) {
    console.log("[stripe-webhook] failed", err);
    return new Response(`Webhook processing failed: ${err?.message || String(err)}`, { status: 500 });
  }
}
