// functions/api/_mail.js
//
// Optional email notifications via Resend.
//
// Env vars to enable:
// - RESEND_API_KEY
// - MAIL_FROM (e.g. "KnowStride <orders@knowstride.com>")
// Optional:
// - MAIL_REPLY_TO (e.g. "service@knowstride.com")

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Stripe stores money in the smallest unit (e.g. cents).
function formatMoneyFromMinor(amountMinor, currency) {
  const c = String(currency || "usd").toUpperCase();
  const minor = Number(amountMinor || 0);
  const major = minor / 100;

  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(major);
  } catch {
    return `${major.toFixed(2)} ${c}`;
  }
}

function shortOrderNumber(prodigiOrderId) {
  // Prodigi IDs often look like: ord_6221...
  // We present a short suffix for customers.
  const s = String(prodigiOrderId || "").trim();
  if (!s) return null;

  // If it contains underscore, show suffix after last underscore
  const parts = s.split("_");
  const tail = parts[parts.length - 1] || s;

  // Keep last 8–10 chars
  const cleaned = tail.replace(/[^a-zA-Z0-9]/g, "");
  if (cleaned.length <= 10) return cleaned;
  return cleaned.slice(-10);
}

async function sendViaResend(env, { to, subject, html, text }) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.MAIL_FROM;
  const replyTo = env.MAIL_REPLY_TO; // optional

  if (!apiKey || !from) {
    console.log("[mail] skipped (missing RESEND_API_KEY or MAIL_FROM)", { to, subject });
    return { ok: false, skipped: true };
  }

  const payload = { from, to, subject, html, text };
  if (replyTo) payload.reply_to = replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log("[mail] resend error", res.status, data);
    return { ok: false, status: res.status, data };
  }

  return { ok: true, data };
}

export async function sendOrderReceivedEmail(env, {
  to,
  posterTitle,
  size,
  paper,
  mode,
  amountTotalMinor, // cents
  currency,
  prodigiOrderId,
  accountUrl,
}) {
  if (!to) return { ok: false, skipped: "missing_to" };

  const money = formatMoneyFromMinor(amountTotalMinor, currency);
  const nicePaper = paper === "fineart" ? "Fine Art" : "Standard";
  const niceMode = mode || "STRICT";
  const niceSize = String(size || "").toUpperCase();

  const orderNo = shortOrderNumber(prodigiOrderId);
  const subject = `Order received — ${posterTitle || "KnowStride"}`;

  const safeAccountUrl = accountUrl || "https://knowstride.com/account.html";

  const text =
`Thanks for your order!

Item: ${posterTitle || "Poster"}
Specs: ${nicePaper} · ${niceSize} · ${niceMode}
Total: ${money}
${orderNo ? `Order number: ${orderNo}` : ""}

You can view your order status here:
${safeAccountUrl}

If you don’t see future updates, check your spam folder and mark KnowStride as safe.`;

  const html = `
    <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;">
      <h2 style="margin:0 0 8px 0;">Thanks — we received your order</h2>
      <p style="margin:0 0 12px 0;">We’ll send another email as soon as it ships.</p>

      <div style="padding:12px;border:1px solid #eee;border-radius:10px;">
        <div><strong>${escapeHtml(posterTitle || "Poster")}</strong></div>
        <div style="color:#666;">${escapeHtml(nicePaper)} · ${escapeHtml(niceSize)} · ${escapeHtml(niceMode)}</div>
        <div style="margin-top:10px;"><strong>Total:</strong> ${escapeHtml(money)}</div>
        ${orderNo ? `<div style="margin-top:6px;color:#666;"><strong>Order number:</strong> ${escapeHtml(orderNo)}</div>` : ""}
        ${prodigiOrderId ? `<div style="margin-top:4px;color:#888;font-size:12px;">Production ref: ${escapeHtml(prodigiOrderId)}</div>` : ""}
      </div>

      <p style="margin:12px 0 0 0;">
        Track status in your account:
        <a href="${escapeHtml(safeAccountUrl)}">${escapeHtml(safeAccountUrl)}</a>
      </p>

      <p style="margin:12px 0 0 0;color:#777;font-size:12px;">
        If you don’t see future updates, check your spam folder and mark KnowStride as safe.
      </p>
    </div>
  `;

  return sendViaResend(env, { to, subject, html, text });
}

export async function sendOrderShippedEmail(env, {
  to,
  name,
  posterTitle,
  amountTotalMinor, // cents (optional)
  currency,
  trackingUrl,
  trackingNumber,
  prodigiOrderId,
}) {
  if (!to) return { ok: false, skipped: "missing_to" };

  const subject = "Your KnowStride order has shipped";
  const safeTitle = posterTitle || "Your poster";
  const money = (amountTotalMinor != null) ? formatMoneyFromMinor(amountTotalMinor, currency) : null;

  const trackingLine = trackingUrl
    ? `<p style="margin:10px 0 0 0;"><a href="${escapeHtml(trackingUrl)}" target="_blank" rel="noopener">Track your package</a></p>`
    : trackingNumber
      ? `<p style="margin:10px 0 0 0;">Tracking number: <strong>${escapeHtml(trackingNumber)}</strong></p>`
      : "";

  const html = `
    <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.45">
      <h2 style="margin:0 0 12px 0;">Shipped ✅</h2>
      <p style="margin:0 0 10px 0;">Hi${name ? ` ${escapeHtml(name)}` : ""},</p>
      <p style="margin:0 0 10px 0;">Your order for <strong>${escapeHtml(safeTitle)}</strong> is on its way.</p>
      ${money ? `<p style="margin:0 0 10px 0;color:#666;">Total: ${escapeHtml(money)}</p>` : ""}
      ${trackingLine}
      ${prodigiOrderId ? `<p style="color:#888;font-size:12px;margin:12px 0 0 0;">Production ref: ${escapeHtml(prodigiOrderId)}</p>` : ""}
      <p style="color:#666;font-size:13px;margin:12px 0 0 0;">— KnowStride</p>
    </div>
  `;

  const text =
    `Shipped! ${safeTitle}. ` +
    (trackingUrl ? `Track: ${trackingUrl}` : trackingNumber ? `Tracking: ${trackingNumber}` : "");

  return sendViaResend(env, { to, subject, html, text });
}
