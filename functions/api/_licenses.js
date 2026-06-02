function b64uEncodeBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64uEncodeString(s) {
  return b64uEncodeBytes(new TextEncoder().encode(String(s || "")));
}

function b64uDecodeBytes(s) {
  const raw = String(s || "").trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = raw + "=".repeat((4 - raw.length % 4) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function b64uDecodeString(s) {
  return new TextDecoder().decode(b64uDecodeBytes(s));
}

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret || "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(message || "")));
  return new Uint8Array(sig);
}

function constantTimeEqualBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function sha256Hex(message) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(message || "")));
  return toHex(new Uint8Array(digest));
}

export function addMonthsIso(startDate, months) {
  const dt = new Date(startDate || Date.now());
  if (Number.isNaN(dt.getTime())) throw new Error("Invalid start date");
  const wholeMonths = Number(months || 0);
  if (!Number.isFinite(wholeMonths) || wholeMonths <= 0) throw new Error("Invalid period months");

  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth();
  const d = dt.getUTCDate();

  const tmp = new Date(Date.UTC(y, m + wholeMonths, 1));
  const lastDay = new Date(Date.UTC(tmp.getUTCFullYear(), tmp.getUTCMonth() + 1, 0)).getUTCDate();
  tmp.setUTCDate(Math.min(d, lastDay));

  return tmp.toISOString().slice(0, 10);
}

export async function signLicensePayload(secret, payload) {
  if (!secret) throw new Error("Missing LICENSE_SECRET");
  const clean = { ...(payload || {}) };
  const blob = JSON.stringify(clean);
  const blobB64 = b64uEncodeString(blob);
  const sig = await hmacSha256(secret, blob);
  const sigB64 = b64uEncodeBytes(sig);
  return `${blobB64}.${sigB64}`;
}

export async function parseSignedLicenseKey(secret, licenseKey) {
  if (!secret) throw new Error("Missing LICENSE_SECRET");
  const raw = String(licenseKey || "").trim();
  if (!raw || !raw.includes(".")) throw new Error("Invalid license key format");

  const parts = raw.split(".");
  if (parts.length !== 2) throw new Error("Invalid license key format");
  const [blobB64, sigB64] = parts;
  const blob = b64uDecodeString(blobB64);
  const payload = JSON.parse(blob);
  const sig = b64uDecodeBytes(sigB64);
  const expected = await hmacSha256(secret, blob);
  if (!constantTimeEqualBytes(sig, expected)) {
    throw new Error("Invalid license signature");
  }
  return {
    payload,
    blob,
    fingerprint: await sha256Hex(raw),
  };
}

export async function generateLicenseRecord({
  secret,
  plan,
  periodMonths,
  seats = 1,
  clerkUserId = "",
  email = "",
  machineId = "",
  issuedAt = new Date(),
}) {
  if (!secret) throw new Error("Missing LICENSE_SECRET");
  const issuedIso = new Date(issuedAt).toISOString();
  const issuedDate = issuedIso.slice(0, 10);
  const exp = addMonthsIso(issuedAt, periodMonths);

  const payload = {
    product: "BOLO",
    plan: String(plan || "licensed"),
    exp,
    seats: Number(seats || 1),
    issued_at: issuedDate,
  };
  if (machineId) payload.machine_id = String(machineId);

  const licenseKey = await signLicensePayload(secret, payload);
  const fingerprint = await sha256Hex(licenseKey);
  const licenseId = `lic_${fingerprint.slice(0, 24)}`;

  return {
    id: licenseId,
    licenseKey,
    licenseFingerprint: fingerprint,
    payload,
    issuedAt: issuedDate,
    expiresAt: exp,
    plan: String(plan || "licensed"),
    periodMonths: Number(periodMonths || 0),
    seats: Number(seats || 1),
    clerkUserId: String(clerkUserId || ""),
    email: String(email || ""),
  };
}

export async function generateActivatedLicenseKey({
  secret,
  basePayload,
  machineId,
  sourceLicenseId = "",
  plan = "",
  seats = 1,
  expiresAt = "",
  issuedAt = new Date(),
}) {
  if (!secret) throw new Error("Missing LICENSE_SECRET");
  const issuedDate = new Date(issuedAt).toISOString().slice(0, 10);
  const payload = {
    product: "BOLO",
    plan: String(plan || basePayload?.plan || "licensed"),
    exp: String(expiresAt || basePayload?.exp || ""),
    seats: Number(seats || basePayload?.seats || 1),
    issued_at: String(basePayload?.issued_at || issuedDate),
    activated_at: issuedDate,
    machine_id: String(machineId || ""),
  };
  if (sourceLicenseId) payload.license_id = String(sourceLicenseId);
  const licenseKey = await signLicensePayload(secret, payload);
  return { licenseKey, payload, licenseFingerprint: await sha256Hex(licenseKey) };
}
