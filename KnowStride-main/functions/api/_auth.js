export async function requireClerkAuth(request, env) {
  const authz = request.headers.get("Authorization") || "";
  const m = authz.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  const token = m[1].trim();
  // Cloudflare Pages env-var names can differ depending on how they were added.
  // We accept a few common variants to avoid "works in one deploy, breaks in another".
  const jwkPublicPem =
    env.CLERK_JWKS_PUBLIC_KEY ||
    env.JWKS_PUBLIC_KEY ||
    env["JWKS Public Key"] ||
    env["JWKS_PUBLIC_KEY"];

  const payload = await verifyClerkJwt(token, jwkPublicPem);
  if (!payload) return null;

  // Clerk brukar ha userId i "sub"
  const userId = payload.sub;
  if (!userId) return null;

  return { userId, claims: payload };
}

async function verifyClerkJwt(jwt, jwkPublicPem) {
  if (!jwkPublicPem) return null;

  const parts = jwt.split(".");
  if (parts.length !== 3) return null;

  const [hB64, pB64, sB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(base64UrlDecodeToString(hB64));
    payload = JSON.parse(base64UrlDecodeToString(pB64));
  } catch {
    return null;
  }

  // Vi förväntar oss RS256 från Clerk
  if (header.alg !== "RS256") return null;

  // exp-check
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) return null;
  if (payload.nbf && now < payload.nbf) return null;

  const data = new TextEncoder().encode(`${hB64}.${pB64}`);
  const sig = base64UrlDecodeToBytes(sB64);

  const key = await importRsaPublicKeyFromPem(jwkPublicPem);
  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    sig,
    data
  );

  return ok ? payload : null;
}

async function importRsaPublicKeyFromPem(pem) {
  // pem = "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
  const clean = pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\s+/g, "");

  const der = base64ToArrayBuffer(clean);
  return crypto.subtle.importKey(
    "spki",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

/* ---------- base64 helpers ---------- */

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

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
