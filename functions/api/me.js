export async function onRequestGet({ request, env }) {
  const auth = await readAuth(request, env);
  if (!auth) return json({ loggedIn: false }, 200);

  return json({ loggedIn: true, userId: auth.uid }, 200);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

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
