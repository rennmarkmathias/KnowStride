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
      plan,
    },
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

/* ---------------- AUTH (same as me.js) ---------------- */
async function readAuth(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const m = cookieHeader.match(/(?:^|;\s*)ks_token=([^;]+)/);
  if (!m) return null;

  const token = m[1];
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [h, b, sig] = parts;
  const data = `${h}.${b}`;

  const ok = await verifyHmacBase64Url(data, sig, env.JWT_SECRET);
  if (!ok) return null;

  let payload;
  try {
    payload = JSON.parse(base64UrlDecodeToString(b));
  } catch {
    return null;
  }

  return payload?.uid ? payload : null;
}

// ---------- Base64url helpers ----------
function base64UrlToBase64(b64url) {
  let s = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return s;
}

function base64UrlDecodeToString(b64url) {
  return atob(base64UrlToBase64(b64url));
}

function base64UrlDecodeToBytes(b64url) {
  const bin = atob(base64UrlToBase64(b64url));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------- HMAC verify (expects base64url signature) ----------
async function verifyHmacBase64Url(data, sigB64Url, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const sigBytes = base64UrlDecodeToBytes(sigB64Url);
  return crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(data));
}
