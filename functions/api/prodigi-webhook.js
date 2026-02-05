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
    null;

  const tu =
    payload?.tracking_url ||
    payload?.trackingUrl ||
    payload?.tracking?.url ||
    payload?.shipment?.trackingUrl ||
    null;

  return {
    trackingNumber: asText(tn),
    trackingUrl: asText(tu),
  };
}

function isShippedStatus(s) {
  const v = String(s || "").toLowerCase();
  return v.includes("ship") || v === "shipped" || v === "dispatched";
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return new Response("DB binding missing", { status: 500 });

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const prodigiOrderId = payload?.order?.id || payload?.orderId || payload?.id || null;
  const merchantReference =
    payload?.order?.merchantReference || payload?.merchantReference || payload?.merchant_reference || null;

  if (!prodigiOrderId && !merchantReference) {
    return new Response("Missing prodigi order identifiers", { status: 400 });
  }

  const prodigiStatus = payload?.order?.status || payload?.status || payload?.orderStatus || null;
  const shippedAt = payload?.order?.shippedAt || payload?.shippedAt || payload?.shipment?.shippedAt || null;

  const { trackingNumber, trackingUrl } = pickTracking(payload);

  // If merchantReference looks like ks_{stripeSessionId}, extract it.
  let stripeSessionId = null;
  if (merchantReference && typeof merchantReference === "string" && merchantReference.startsWith("ks_")) {
    stripeSessionId = merchantReference.slice(3);
  }

  try {
    // Update by prodigi_order_id if possible, else by stripe_session_id
    if (prodigiOrderId) {
      await env.DB.prepare(
        `UPDATE orders
         SET
           prodigi_status = ?,
           tracking_number = COALESCE(?, tracking_number),
           tracking_url = COALESCE(?, tracking_url),
           shipped_at = COALESCE(?, shipped_at),
           status = CASE
             WHEN ? IS NOT NULL AND LOWER(?) LIKE '%ship%' THEN 'shipped'
             WHEN ? IS NOT NULL THEN 'in_production'
             ELSE status
           END,
           updated_at = datetime('now')
         WHERE prodigi_order_id = ?`
      )
        .bind(
          asText(prodigiStatus),
          trackingNumber,
          trackingUrl,
          shippedAt ? (Date.parse(asText(shippedAt)) || null) : null,
          asText(prodigiStatus),
          asText(prodigiStatus),
          asText(prodigiStatus),
          asText(prodigiOrderId)
        )
        .run();
    } else if (stripeSessionId) {
      await env.DB.prepare(
        `UPDATE orders
         SET
           prodigi_status = ?,
           tracking_number = COALESCE(?, tracking_number),
           tracking_url = COALESCE(?, tracking_url),
           shipped_at = COALESCE(?, shipped_at),
           status = CASE
             WHEN ? IS NOT NULL AND LOWER(?) LIKE '%ship%' THEN 'shipped'
             WHEN ? IS NOT NULL THEN 'in_production'
             ELSE status
           END,
           updated_at = datetime('now')
         WHERE stripe_session_id = ?`
      )
        .bind(
          asText(prodigiStatus),
          trackingNumber,
          trackingUrl,
          shippedAt ? (Date.parse(asText(shippedAt)) || null) : null,
          asText(prodigiStatus),
          asText(prodigiStatus),
          asText(prodigiStatus),
          asText(stripeSessionId)
        )
        .run();
    }

    // If shipped, fetch order row and send shipped email (best effort)
    if (isShippedStatus(prodigiStatus) && (trackingUrl || trackingNumber)) {
      const row = prodigiOrderId
        ? await env.DB.prepare(
            `SELECT email, poster_title, amount_total, currency, prodigi_order_id
             FROM orders WHERE prodigi_order_id = ? LIMIT 1`
          ).bind(asText(prodigiOrderId)).first()
        : stripeSessionId
          ? await env.DB.prepare(
              `SELECT email, poster_title, amount_total, currency, prodigi_order_id
               FROM orders WHERE stripe_session_id = ? LIMIT 1`
            ).bind(asText(stripeSessionId)).first()
          : null;

      if (row?.email) {
        try {
          await sendOrderShippedEmail(env, {
            to: row.email,
            posterTitle: row.poster_title || "Poster",
            amountTotalMinor: row.amount_total, // cents in DB
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
