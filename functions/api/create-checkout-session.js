import Stripe from "stripe";

export async function onRequestPost({ request, env }) {
  const auth = await readAuth(request, env);
  if (!auth) return json({ error: "Not logged in." }, 401);

  const body = await request.json().catch(() => null);
  const plan = (body?.plan || "").toLowerCase();

  const priceId = getPriceId(plan, env);
  if (!priceId) return json({ error: "Unknown plan." }, 400);

  const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

  const origin = new URL(request.url).origin;

  const session = await stripe.checkout.sessions.create({
    mode: isRecurring(plan) ? "subscription" : "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${origin}/app.html?plan=${encodeURIComponent(plan)}&success=1`,
    cancel_url: `${origin}/app.html?plan=${encodeURIComponent(plan)}&canceled=1`,
    metadata: {
      user_id: auth.uid,
      plan
    }
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

function json(obj, status=200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type":"application/json" }});
}

async function readAuth(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)ks_token=([^;]+)/);
  if (!m) return null;
  const token = m[1];
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, b, sig] = parts;
  const data = `${h}.${b}`;
  const ok = await verifyHmac(data, sig, env.JWT_SECRET);
  if (!ok) return null;
  const payload = JSON.parse(atob(b));
  return payload?.uid ? payload : null;
}

async function verifyHmac(data, sigB64, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["verify"]);
  const sig = Uint8Array.from(atob(sigB64 + "=".repeat((4 - sigB64.length%4)%4)), c => c.charCodeAt(0));
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(data));
}
