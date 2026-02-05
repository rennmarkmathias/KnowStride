// functions/api/_mail.js
//
// Optional email notifications via Resend.
//
// Env vars to enable:
// - RESEND_API_KEY
// - MAIL_FROM (e.g. "KnowStride <orders@knowstride.com>")

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

  // Most currencies you’ll use here are 2 decimals (USD/EUR/GBP etc).
  // If you later add JPY etc, we can add a map for 0-decimal currencies.
  const major = minor / 100;

  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: c }).format(major);
  } catch {
    return `${major.toFixed(2)} ${c}`;
  }
}

async function sendViaResend(env, { to, subject, html, text }) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.MAIL_FROM;

  if (!apiKey || !from) {
    console.log("[mail] skipped (missing RESEND_API_KEY or MAIL_FROM)", { to, subject });
    return { ok: false, skipped: true };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html, text }),
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

  const subject = `Order received — ${posterTitle || "KnowStride"}`;

  const text =
`Thanks for your order!

Item: ${posterTitle || "Poster"}
Specs: ${nicePaper} · ${niceSize} · ${niceMode}
Total: ${money}
Print ref: ${prodigiOrderId || "(pending)"}

You can view your order status here:
${accountUrl || "https://knowstride.com/account.html"}`;

  const html = `
    <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;">
      <h2 style="margin:0 0 8px 0;">Thanks — we received your order 🎉</h2>
      <p style="margin:0 0 12px 0;">We’ll send another email as soon as it ships.</p>

      <div style="padding:12px;border:1px solid #eee;border-radius:10px;">
        <div><strong>${escapeHtml(posterTitle || "Poster")}</strong></div>
        <div style="color:#666;">${escapeHtml(nicePaper)} · ${escapeHtml(niceSize)} · ${escapeHtml(niceMode)}</div>
        <div style="margin-top:10px;"><strong>Total:</strong> ${escapeHtml(money)}</div>
        ${prodigiOrderId ? `<div style="margin-top:4px;color:#666;">Print ref: ${escapeHtml(prodigiOrderId)}</div>` : ""}
      </div>

      <p style="margin:12px 0 0 0;">
        Track status in your account:
        <a href="${escapeHtml(accountUrl || "https://knowstride.com/account.html")}">${escapeHtml(accountUrl || "https://knowstride.com/account.html")}</a>
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
      ${prodigiOrderId ? `<p style="color:#666;font-size:13px;margin:12px 0 0 0;">Print ref: ${escapeHtml(prodigiOrderId)}</p>` : ""}
      <p style="color:#666;font-size:13px;margin:12px 0 0 0;">— KnowStride</p>
    </div>
  `;

  const text = `Shipped! ${safeTitle}. ${trackingUrl ? `Track: ${trackingUrl}` : trackingNumber ? `Tracking: ${trackingNumber}` : ""}`;
  return sendViaResend(env, { to, subject, html, text });
}
