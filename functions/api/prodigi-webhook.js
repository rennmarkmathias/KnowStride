// functions/api/prodigi-webhook.js
import { sendOrderShippedEmail } from "./_mail.js";

function asText(v) {
  if (v == null) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function pickTracking(payload) {
  const tn =
    payload?.tracking_number ||
    payload?.trackingNumber ||
    payload?.tracking?.number ||
    payload?.shipment?.trackingNumber ||
    payload?.order?.tracking?.number ||
    null;

  const tu =
    payload?.tracking_url ||
    payload?.trackingUrl ||
    payload?.tracking?.url ||
    payload?.shipment?.trackingUrl ||
    payload?.order?.tracking?.url ||
    null;

  return {
    trackingNumber: asText(tn),
    trackingUrl: asText(tu),
  };
}

function normalizeProdigiStatus(payload) {
  // Prodigi can send: payload.order.status, payload.status, etc.
  const s =
    payload?.order?.status ||
    payload?.status ||
    payload?.orderStatus ||
    null;
  return asText(s);
}

function isShippedStatus(status) {
  const v = String(status || "").toLowerCase().trim();
  // Prodigi commonly uses "Dispatched" for shipped.
  return v.includes("ship") || v.includes("dispatch") || v === "shipped" || v === "dispatched";
}

function parseTimestampToEpochMs(v) {
  if (!v) return null;
  const s = asText(v);
  // If already number-like:
  const n = Number(s);
  if (!Number.isNaN(n) && Number.isFinite(n)) {
    // Heuristic: if it looks like seconds, convert
    if (n > 0 && n < 1e12) return Math.round(n * 1000);
    return Math.round(n);
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

function dollarsToMinor(amountMajor, currency) {
  // Your DB stores amount_total as major (e.g. 1.00).
  // Most currencies here are 2 decimals.
  const major = Number(amountMajor);
  if (!Number.isFinite(major)) return null;

  const c = String(currency || "usd").toLowerCase();
  // If you later add zero-decimal currencies, we can extend this.
  const factor = 100;

  return Math.round(major * factor);
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return new Response("DB binding missing", { status: 500 });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const prodigiOrderId =
    payload?.order?.id ||
    payload?.orderId ||
    payload?.id ||
    null;

  const merchantReference =
    payload?.order?.merchantReference ||
    payload?.merchantReference ||
    payload?.merchant_reference ||
    null;

  if (!prodigiOrderId && !merchantReference) {
    return new Response("Missing prodigi order identifiers", { status: 400 });
  }

  const prodigiStatus = normalizeProdigiStatus(payload);

  const shippedAtRaw =
    payload?.order?.shippedAt ||
    payload?.shippedAt ||
    payload?.shipment?.shippedAt ||
    null;

  const shippedAtMs = parseTimestampToEpochMs(shippedAtRaw);

  const { trackingNumber, trackingUrl } = pickTracking(payload);

  // If merchantReference looks like ks_{stripeSessionId}, extract it.
  let stripeSessionId = null;
  if (merchantReference && typeof merchantReference === "string" && merchantReference.startsWith("ks_")) {
    stripeSessionId = merchantReference.slice(3);
  }

  try {
    // 1) Update DB row (by prodigi_order_id preferred; fallback stripe_session_id)
    if (prodigiOrderId) {
      await env.DB.prepare(
        `UPDATE orders
         SET
           prodigi_status = COALESCE(?, prodigi_status),
           tracking_number = COALESCE(?, tracking_number),
           tracking_url = COALESCE(?, tracking_url),
           shipped_at = COALESCE(?, shipped_at),
           status = CASE
             WHEN ? = 1 THEN 'shipped'
             WHEN prodigi_status IS NOT NULL THEN 'in_production'
             ELSE status
           END,
           updated_at = datetime('now')
         WHERE prodigi_order_id = ?`
      )
        .bind(
          prodigiStatus,
          trackingNumber,
          trackingUrl,
          shippedAtMs,
          isShippedStatus(prodigiStatus) ? 1 : 0,
          asText(prodigiOrderId)
        )
        .run();
    } else if (stripeSessionId) {
      await env.DB.prepare(
        `UPDATE orders
         SET
           prodigi_status = COALESCE(?, prodigi_status),
           tracking_number = COALESCE(?, tracking_number),
           tracking_url = COALESCE(?, tracking_url),
           shipped_at = COALESCE(?, shipped_at),
           status = CASE
             WHEN ? = 1 THEN 'shipped'
             WHEN prodigi_status IS NOT NULL THEN 'in_production'
             ELSE status
           END,
           updated_at = datetime('now')
         WHERE stripe_session_id = ?`
      )
        .bind(
          prodigiStatus,
          trackingNumber,
          trackingUrl,
          shippedAtMs,
          isShippedStatus(prodigiStatus) ? 1 : 0,
          asText(stripeSessionId)
        )
        .run();
    }

    // 2) Send shipped email (ONLY ONCE) when shipped + has tracking
    if (isShippedStatus(prodigiStatus) && (trackingUrl || trackingNumber)) {
      const row = prodigiOrderId
        ? await env.DB.prepare(
            `SELECT
               email,
               poster_title,
               amount_total,
               currency,
               prodigi_order_id,
               shipped_email_sent_at
             FROM orders
             WHERE prodigi_order_id = ?
             LIMIT 1`
          ).bind(asText(prodigiOrderId)).first()
        : stripeSessionId
          ? await env.DB.prepare(
              `SELECT
                 email,
                 poster_title,
                 amount_total,
                 currency,
                 prodigi_order_id,
                 shipped_email_sent_at
               FROM orders
               WHERE stripe_session_id = ?
               LIMIT 1`
            ).bind(asText(stripeSessionId)).first()
          : null;

      // Already sent? -> do nothing
      if (row?.shipped_email_sent_at) {
        return new Response("ok", { status: 200 });
      }

      if (row?.email) {
        // Mark as sent FIRST (idempotent) then send (best effort)
        const nowMs = Date.now();

        if (row?.prodigi_order_id) {
          await env.DB.prepare(
            `UPDATE orders
             SET shipped_email_sent_at = COALESCE(shipped_email_sent_at, ?),
                 updated_at = datetime('now')
             WHERE prodigi_order_id = ?`
          ).bind(nowMs, asText(row.prodigi_order_id)).run();
        } else if (prodigiOrderId) {
          await env.DB.prepare(
            `UPDATE orders
             SET shipped_email_sent_at = COALESCE(shipped_email_sent_at, ?),
                 updated_at = datetime('now')
             WHERE prodigi_order_id = ?`
          ).bind(nowMs, asText(prodigiOrderId)).run();
        } else if (stripeSessionId) {
          await env.DB.prepare(
            `UPDATE orders
             SET shipped_email_sent_at = COALESCE(shipped_email_sent_at, ?),
                 updated_at = datetime('now')
             WHERE stripe_session_id = ?`
          ).bind(nowMs, asText(stripeSessionId)).run();
        }

        const amountMinor = dollarsToMinor(row.amount_total, row.currency);

        try {
          await sendOrderShippedEmail(env, {
            to: row.email,
            posterTitle: row.poster_title || "Poster",
            amountTotalMinor: amountMinor, // convert DB major -> minor
            currency: row.currency || "usd",
            trackingUrl,
            trackingNumber,
            prodigiOrderId: row.prodigi_order_id || asText(prodigiOrderId),
          });
        } catch (e) {
          console.log("[mail] shipped email failed", e?.message || String(e));
        }
      }
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    return new Response(`Prodigi webhook error: ${err?.message || String(err)}`, { status: 500 });
  }
}
