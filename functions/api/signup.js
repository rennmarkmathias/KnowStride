export async function onRequestPost({ request, env }) {
  const body = await request.json().catch(() => null);
  const email = (body?.email || "").toLowerCase().trim();
  const password = body?.password || "";

  if (!email || !password || password.length < 8) {
    return json({ error: "Invalid email or password (min 8 chars)." }, 400);
  }

  const existing = await env.DB
    .prepare("SELECT id FROM users WHERE email = ?")
    .bind(email)
    .first();

  if (existing) return json({ error: "Email already registered." }, 409);

  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const passwordHash = await hashPassword(password, env.JWT_SECRET);

  await env.DB
    .prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, email, passwordHash, createdAt)
    .run();

  const token = await signJwt({ uid: id }, env.JWT_SECRET);

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie("ks_token", token, {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: parseInt(env.AUTH_COOKIE_MAX_AGE || "31536000", 10),
      }),
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cookie(name, value, opts) {
  const parts = [`${name}=${value}`];
  if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  return parts.join("; ");
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const data = enc.encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------- JWT: base64url everywhere ----------
function base64UrlEncode(str) {
  // JSON header/body är ASCII/UTF-8 här, så detta funkar bra
  return btoa(str).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlEncodeFromBinaryString(binStr) {
  return btoa(binStr).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function signJwt(payload, secret) {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = await hmacSignBase64Url(data, secret);
  return `${data}.${sig}`;
}

async function hmacSignBase64Url(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const bytes = new Uint8Array(sigBuf);

  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));

  return base64UrlEncodeFromBinaryString(bin);
}
