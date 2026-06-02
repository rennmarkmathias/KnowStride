import { parseSignedLicenseKey, generateActivatedLicenseKey, sha256Hex } from "../_licenses.js";

function corsHeaders() {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  };
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...corsHeaders(), ...(init.headers || {}) },
  });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function cleanMachineId(value) {
  const s = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(s)) return "";
  return s;
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ ok: false, error: "DB binding missing" }, { status: 500 });
  if (!env.LICENSE_SECRET) return json({ ok: false, error: "LICENSE_SECRET missing" }, { status: 500 });

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const purchaseKey = String(body?.license_key || body?.licenseKey || "").trim();
  const machineId = cleanMachineId(body?.machine_id || body?.machineId);
  const appVersion = String(body?.app_version || body?.appVersion || "").slice(0, 80);
  const userAgent = String(request.headers.get("user-agent") || "").slice(0, 240);

  if (!purchaseKey) return json({ ok: false, error: "Missing license_key" }, { status: 400 });
  if (!machineId) return json({ ok: false, error: "Invalid or missing machine_id" }, { status: 400 });

  let parsed;
  try {
    parsed = await parseSignedLicenseKey(env.LICENSE_SECRET, purchaseKey);
  } catch (err) {
    return json({ ok: false, error: err?.message || "Invalid license key" }, { status: 400 });
  }

  const payload = parsed.payload || {};
  if (String(payload.product || "BOLO") !== "BOLO") {
    return json({ ok: false, error: "This is not a BOLO license." }, { status: 400 });
  }

  const existingMachine = String(payload.machine_id || "").trim();
  if (existingMachine) {
    if (existingMachine !== machineId) {
      return json({ ok: false, error: "This license is already bound to another computer." }, { status: 403 });
    }
    return json({
      ok: true,
      license_key: purchaseKey,
      machine_id: machineId,
      plan: payload.plan || "licensed",
      seats: Number(payload.seats || 1),
      expires_at: payload.exp || "",
      message: "License already activated for this computer.",
    });
  }

  const baseFingerprint = parsed.fingerprint || await sha256Hex(purchaseKey);
  const lic = await env.DB.prepare(
    `SELECT id, license_key, license_fingerprint, plan, seats, status, expires_at
       FROM licenses
      WHERE license_fingerprint = ?
      LIMIT 1`
  ).bind(baseFingerprint).first();

  if (!lic?.id) {
    return json({ ok: false, error: "License was not found on the activation server." }, { status: 404 });
  }

  if (String(lic.status || "").toLowerCase() !== "active") {
    return json({ ok: false, error: "License is not active." }, { status: 403 });
  }

  const expiresAt = String(lic.expires_at || payload.exp || "");
  if (expiresAt && expiresAt < todayIso()) {
    return json({ ok: false, error: "License has expired." }, { status: 403 });
  }

  const seats = Math.max(1, Number(lic.seats || payload.seats || 1));

  const already = await env.DB.prepare(
    `SELECT id FROM license_activations
      WHERE license_id = ? AND machine_id = ? AND revoked_at IS NULL
      LIMIT 1`
  ).bind(lic.id, machineId).first();

  if (!already?.id) {
    const usage = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM license_activations
        WHERE license_id = ? AND revoked_at IS NULL`
    ).bind(lic.id).first();
    const used = Number(usage?.n || 0);
    if (used >= seats) {
      return json({
        ok: false,
        error: `No seats left. This license has ${seats} seat(s), and all are already activated.`,
        seats,
        used_seats: used,
      }, { status: 403 });
    }
  }

  const activationFingerprint = await sha256Hex(`${lic.id}:${machineId}`);
  const activationId = `act_${activationFingerprint.slice(0, 24)}`;

  await env.DB.prepare(
    `INSERT INTO license_activations (
       id, license_id, machine_id, activation_fingerprint,
       created_at, last_seen_at, revoked_at, app_version, user_agent
     ) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), NULL, ?, ?)
     ON CONFLICT(license_id, machine_id) DO UPDATE SET
       last_seen_at = datetime('now'),
       revoked_at = NULL,
       app_version = excluded.app_version,
       user_agent = excluded.user_agent`
  ).bind(activationId, lic.id, machineId, activationFingerprint, appVersion, userAgent).run();

  const activated = await generateActivatedLicenseKey({
    secret: env.LICENSE_SECRET,
    basePayload: payload,
    machineId,
    sourceLicenseId: lic.id,
    plan: lic.plan,
    seats,
    expiresAt,
    issuedAt: new Date(),
  });

  const usageAfter = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM license_activations
      WHERE license_id = ? AND revoked_at IS NULL`
  ).bind(lic.id).first();

  return json({
    ok: true,
    license_key: activated.licenseKey,
    machine_id: machineId,
    plan: lic.plan,
    seats,
    used_seats: Number(usageAfter?.n || 0),
    expires_at: expiresAt,
    message: "License activated for this computer.",
  });
}
