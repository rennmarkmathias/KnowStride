export async function onRequestGet({ request, env }) {
  const auth = await readAuth(request, env);
  if (!auth) return json({ loggedIn: false }, 200);

  return json({ loggedIn: true, userId: auth.uid }, 200);
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
