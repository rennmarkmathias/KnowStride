// functions/api/prodigi-webhook.js

function asText(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function pickTracking(payload) {
  // Försök hitta tracking info i några vanliga varianter
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

export async function onRequestPost({ request, env }) {
  if (!env.DB) {
    return new Response("DB binding missing", { status: 500 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Prodigi skickar typiskt någon form av order id och/eller merchantReference
  const prodigiOrderId = payload?.order?.id || payload?.orderId || payload?.id || null;
  const merchantReference =
    payload?.order?.merchantReference || payload?.merchantReference || payload?.merchant_reference || null;

  if (!prodigiOrderId && !merchantReference) {
    return new Response("Missing prodigi order identifiers", { status: 400 });
  }

  // Status kan vara string, eller ibland ett object beroende på webhook-variant
  const prodigiStatus =
    payload?.order?.status ||
    payload?.status ||
    payload?.orderStatus ||
    null;

  const shippedAt =
    payload?.order?.shippedAt ||
    payload?.shippedAt ||
    payload?.shipment?.shippedAt ||
    null;

  const { trackingNumber, trackingUrl } = pickTracking(payload);

  // Vi matchar i DB via prodigi_order_id om den finns, annars via stripe session id från merchantReference (ks_{sessionId})
  let stripeSessionId = null;
  if (merchantReference && typeof merchantReference === "string" && merchantReference.startsWith("ks_")) {
    stripeSessionId = merchantReference.slice(3);
  }

  try {
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
           END
         WHERE prodigi_order_id = ?`
      )
        .bind(
          asText(prodigiStatus),
          trackingNumber,
          trackingUrl,
          shippedAt ? Date.parse(asText(shippedAt)) || null : null,

          asText(prodigiStatus),
          asText(prodigiStatus),
          asText(prodigiStatus),

          asText(prodigiOrderId)
        )
        .run();

      return new Response("ok", { status: 200 });
    }

    if (stripeSessionId) {
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
           END
         WHERE stripe_session_id = ?`
      )
        .bind(
          asText(prodigiStatus),
          trackingNumber,
          trackingUrl,
          shippedAt ? Date.parse(asText(shippedAt)) || null : null,

          asText(prodigiStatus),
          asText(prodigiStatus),
          asText(prodigiStatus),

          asText(stripeSessionId)
        )
        .run();

      return new Response("ok", { status: 200 });
    }

    return new Response("No matching strategy", { status: 200 });
  } catch (err) {
    return new Response(`Prodigi webhook error: ${err?.message || String(err)}`, { status: 500 });
  }
}
