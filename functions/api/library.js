export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  // --- Auth via ks_token cookie (JWT) ---
  const auth = await readAuth(request, env);
  if (!auth) return json({ error: "Not logged in." }, 401);

  // --- For now: if user has NOT paid, library is empty ---
  // Later, Stripe webhook will set users.has_paid = 1 (or paid_until).
  const user = await env.DB.prepare(
    "SELECT id, email, created_at, has_paid FROM users WHERE id = ?"
  ).bind(auth.uid).first();

  if (!user) return json({ error: "User not found." }, 404);

  const hasPaid = !!user.has_paid;

  // If not paid => show empty library (as you requested)
  if (!hasPaid) {
    return json({
      startedAt: new Date(user.created_at).toISOString(),
      unlockedCount: 0,
      firstAvailable: 0,
      retention: 52,
      totalBlocksAvailable: 0,
      blocks: [],
      hasPaid: false
    });
  }

  // --- Paid users: unlock 1 block per 7 days from start time ---
  const startedAt = new Date(user.created_at);
  const now = new Date();
  const days = Math.floor((now - startedAt) / (1000 * 60 * 60 * 24));
  const unlockedCount = Math.max(1, Math.floor(days / 7) + 1);

  // Retention policy: keep 52 most recent blocks accessible
  const retention = 52;
  const firstAvailable = Math.max(1, unlockedCount - retention + 1);

  // --- Total blocks available (manifest) ---
  let totalBlocksAvailable = unlockedCount;
  try {
    const manifestUrl = new URL("/blocks/manifest.json", url);
    const m = await fetch(manifestUrl.toString(), {
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (m.ok) {
      const j = await m.json();
      if (typeof j.latest === "number" && j.latest > 0) totalBlocksAvailable = j.latest;
    }
  } catch (_) {}

  const maxUnlocked = Math.min(unlockedCount, totalBlocksAvailable);
  const blocks = [];
  for (let n = maxUnlocked; n >= firstAvailable; n--) blocks.push({ number: n });

  // --- If a specific block is requested, return its HTML ---
  const blockParam = url.searchParams.get("block");
  if (blockParam) {
    const n = Number(blockParam);
    if (!Number.isFinite(n) || n < 1) return json({ error: "Invalid block number" }, 400);
    if (n < firstAvailable || n > maxUnlocked) return json({ error: "Not unlocked or not available" }, 403);

    const blockUrl = new URL(`/blocks/knowstride${n}.html`, url);
    const r = await fetch(blockUrl.toString(), { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!r.ok) return json({ error: "Block file not found. Upload it to /public/blocks first." }, 404);

    const html = await r.text();
    return json({ html, block: n });
  }

  return json({
    startedAt: startedAt.toISOString(),
    unlockedCount: maxUnlocked,
    firstAvailable,
    retention,
    totalBlocksAvailable,
    blocks,
    hasPaid: true
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --- JWT cookie auth helpers (base64url-safe) ---
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

  const payloadJson = b64urlDecodeToString(b);
  const payload = JSON.parse(payloadJson);
  return payload?.uid ? payload : null;
}

async function verifyHmac(data, sigB64Url, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const sigBytes = b64urlDecodeToBytes(sigB64Url);
  return crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(data));
}

function b64urlDecodeToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlDecodeToString(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  return atob(b64 + pad);
}
