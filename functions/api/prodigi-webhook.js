// functions/api/prodigi-webhook.js

import { sendOrderShippedEmail } from "./_mail.js";
//
// Optional: receive order status updates from Prodigi and update D1 so customers can
// see tracking/status in their account.
//
// NOTE: Prodigi's exact webhook signature headers can vary by configuration.
// This handler supports an HMAC-SHA256 header if you set PRODIGI_WEBHOOK_SECRET.

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function verifySignature({ secret, body, headers }) {
  if (!secret) return true; // no verification configured

  const sig =
    headers.get("x-prodigi-hmac-sha256") ||
    headers.get("x-prodigi-signature") ||
    headers.get("x-hub-signature-256") ||
    "";
  if (!sig) return true; // can't verify without a header; accept but you can tighten later

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body)
  );
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)));

  // Some systems prefix like "sha256=..." – compare loosely.
  const normalized = sig.replace(/^sha256=/i, "").trim();
  return normalized === b64;
}

export async function onRequestPost(context) {
  const { env, request } = context;

  const body = await request.text();
  const okSig = await verifySignature({
    secret: env.PRODIGI_WEBHOOK_SECRET,
    body,
    headers: request.headers,
  });
  if (!okSig) {
    return jsonResponse({ error: "Invalid signature" }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(body || "{}");
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  // Best-effort extraction. Adjust once we see a real Prodigi payload.
  const prodigiOrderId = payload.orderId || payload.id || payload.order?.id || null;
  const merchantReference =
    payload.merchantReference || payload.order?.merchantReference || null;
  const status = payload.status || payload.order?.status || payload.event || null;

  const trackingNumber =
    payload.trackingNumber ||
    payload.tracking?.number ||
    payload.shipment?.trackingNumber ||
    null;
  const trackingUrl =
    payload.trackingUrl ||
    payload.tracking?.url ||
    payload.shipment?.trackingUrl ||
    null;

  const shippedAt =
    payload.shippedAt || payload.shipment?.shippedAt || payload.order?.shippedAt || null;

  if (!env.DB) {
    return jsonResponse({ ok: true, note: "DB not configured" }, 200);
  }

  // Fetch existing order row (for email + to detect "first time" tracking update)
  let existing = null;
  if (prodigiOrderId) {
    const r = await env.DB.prepare(
      `SELECT id, email, poster_title, tracking_number, tracking_url
       FROM orders
       WHERE prodigi_order_id = ?
       LIMIT 1`
    )
      .bind(prodigiOrderId)
      .first();
    existing = r || null;
  }

  // Try update by Prodigi order id first, then fallback to merchantReference ks_<stripeSessionId>
  let updated = 0;
  if (prodigiOrderId) {
    const r = await env.DB.prepare(
      `UPDATE orders
         SET prodigi_status = COALESCE(?, prodigi_status),
             tracking_number = COALESCE(?, tracking_number),
             tracking_url = COALESCE(?, tracking_url),
             shipped_at = COALESCE(?, shipped_at),
             updated_at = datetime('now')
       WHERE prodigi_order_id = ?`
    )
      .bind(status, trackingNumber, trackingUrl, shippedAt, prodigiOrderId)
      .run();
    updated = r?.meta?.changes || 0;
  }

  if (!updated && merchantReference && merchantReference.startsWith("ks_")) {
    const stripeSessionId = merchantReference.slice(3);
    const r = await env.DB.prepare(
      `UPDATE orders
         SET prodigi_status = COALESCE(?, prodigi_status),
             tracking_number = COALESCE(?, tracking_number),
             tracking_url = COALESCE(?, tracking_url),
             shipped_at = COALESCE(?, shipped_at),
             updated_at = datetime('now')
       WHERE stripe_session_id = ?`
    )
      .bind(status, trackingNumber, trackingUrl, shippedAt, stripeSessionId)
      .run();
    updated = r?.meta?.changes || 0;

    // If we had to fallback to stripe_session_id, we can also fetch the row now
    if (!existing) {
      const row = await env.DB.prepare(
        `SELECT id, email, poster_title, tracking_number, tracking_url
         FROM orders
         WHERE stripe_session_id = ?
         LIMIT 1`
      )
        .bind(stripeSessionId)
        .first();
      existing = row || null;
    }
  }

  // Optional: shipping notification email if tracking just appeared
  // (No-op unless RESEND_API_KEY + MAIL_FROM are configured.)
  if (
    updated &&
    existing?.email &&
    (trackingUrl || trackingNumber) &&
    !existing.tracking_url &&
    !existing.tracking_number
  ) {
    await sendOrderShippedEmail(env, {
      to: existing.email,
      posterTitle: existing.poster_title || "Your poster",
      trackingUrl: trackingUrl || undefined,
      trackingNumber: trackingNumber || undefined,
      prodigiOrderId: prodigiOrderId || undefined,
    });
  }

  return jsonResponse({ ok: true, updated }, 200);
}
