// functions/api/_mail.js
//
// Optional email notifications.
//
// This is intentionally "plug-and-play":
// - If you set RESEND_API_KEY + MAIL_FROM in Cloudflare env vars, emails are sent via Resend.
// - If not set, we simply no-op (but log) so the rest of checkout/order flow works.

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
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
      text,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log("[mail] resend error", res.status, data);
    return { ok: false, status: res.status, data };
  }

  return { ok: true, data };
}

function formatMoney(amountMajor, currency) {
  const c = String(currency || "usd").toUpperCase();
  const n = Number(amountMajor || 0);
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: c,
    }).format(n);
  } catch {
    return `${n.toFixed(2)} ${c}`;
  }
}

export async function sendOrderReceivedEmail(env, {
  to,
  posterTitle,
  size,
  paper,
  mode,
  amountTotal,
  currency,
  prodigiOrderId,
  accountUrl,
}) {
  if (!to) return { ok: false, skipped: true };

  const money = formatMoney(amountTotal, currency);
  const nicePaper = paper === "fineart" ? "Fine Art" : "Standard";
  const niceMode = mode || "STRICT";
  const niceSize = String(size || "").toUpperCase();

  const subject = `Order received — ${posterTitle || "KnowStride"}`;
  const text = `Thanks for your order!\n\nItem: ${posterTitle || "Poster"}\nSpecs: ${nicePaper} · ${niceSize} · ${niceMode}\nTotal: ${money}\nPrint ref: ${prodigiOrderId || "(pending)"}\n\nYou can view your order status here: ${accountUrl || "https://knowstride.com/account"}`;

  const html = `
    <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial;line-height:1.5;">
      <h2 style="margin:0 0 8px 0;">Thanks — we received your order 🎉</h2>
      <p style="margin:0 0 12px 0;">We\'ll send another email as soon as it ships.</p>
      <div style="padding:12px;border:1px solid #eee;border-radius:10px;">
        <div><strong>${posterTitle || "Poster"}</strong></div>
        <div style="color:#666;">${nicePaper} · ${niceSize} · ${niceMode}</div>
        <div style="margin-top:10px;"><strong>Total:</strong> ${money}</div>
        ${prodigiOrderId ? `<div style="margin-top:4px;color:#666;">Print ref: ${prodigiOrderId}</div>` : ""}
      </div>
      <p style="margin:12px 0 0 0;">Track status in your account: <a href="${accountUrl || "https://knowstride.com/account"}">${accountUrl || "https://knowstride.com/account"}</a></p>
    </div>
  `;

  return sendViaResend(env, { to, subject, html, text });
}

export async function sendOrderShippedEmail(env, {
  to,
  name,
  posterTitle,
  amount,
  currency,
  trackingUrl,
  trackingNumber,
  prodigiOrderId,
}) {
  if (!to) return { ok: false, skipped: "missing_to" };

  const subject = "Your KnowStride order has shipped";
  const safeTitle = posterTitle || "Your poster";
  const trackingLine = trackingUrl
    ? `<p><a href="${trackingUrl}" target="_blank" rel="noopener">Track your package</a></p>`
    : trackingNumber
      ? `<p>Tracking number: <strong>${trackingNumber}</strong></p>`
      : "";

  const html = `
    <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;line-height:1.45">
      <h2 style="margin:0 0 12px">Shipped ✅</h2>
      <p>Hi${name ? ` ${escapeHtml(name)}` : ""},</p>
      <p>Your order for <strong>${escapeHtml(safeTitle)}</strong> is on its way.</p>
      ${trackingLine}
      ${prodigiOrderId ? `<p style="color:#666;font-size:13px">Print ref: ${escapeHtml(prodigiOrderId)}</p>` : ""}
      <p style="color:#666;font-size:13px">— KnowStride</p>
    </div>
  `;

  const text = `Shipped! ${safeTitle}. ${trackingUrl ? `Track: ${trackingUrl}` : trackingNumber ? `Tracking: ${trackingNumber}` : ""}`;
  return sendViaResend(env, { to, subject, html, text });
}
