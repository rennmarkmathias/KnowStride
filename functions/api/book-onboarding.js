// functions/api/book-onboarding.js
// Cloudflare Pages Function endpoint used by the onboarding popup.
// Sends one booking email to BOLO and one confirmation email to the person who booked.
// Environment variables:
//   RESEND_API_KEY=...
//   BOOKING_FROM=BOLO <info@bolowriter.com>
//   BOOKING_TO=info@bolowriter.com

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const data = await request.json();

    const required = ["slot", "slot_label", "name", "email", "organization"];
    for (const field of required) {
      if (!data[field] || String(data[field]).trim().length < 2) {
        return json({ ok: false, error: `Missing field: ${field}` }, 400);
      }
    }

    const resendApiKey = env.RESEND_API_KEY;
    const from = env.BOOKING_FROM || "BOLO <info@bolowriter.com>";
    const to = env.BOOKING_TO || "info@bolowriter.com";

    if (!resendApiKey) {
      return json({ ok: false, error: "RESEND_API_KEY is not configured" }, 500);
    }

    const bookingSubject = `BOLO onboarding bokad: ${data.slot_label}`;
    const bookingText = [
      "Ny onboardingbokning via BOLO utbildningssida",
      "",
      `Tid: ${data.slot_label}`,
      `Namn: ${data.name}`,
      `E-post: ${data.email}`,
      `Skola/organisation: ${data.organization}`,
      `Roll: ${data.role || "-"}`,
      "",
      "Kommentar:",
      data.message || "-",
      "",
      `Källa: ${data.source || "-"}`
    ].join("\n");

    const confirmationSubject = `Din BOLO-onboarding är bokad: ${data.slot_label}`;
    const confirmationText = [
      `Hej ${data.name},`,
      "",
      "Tack för din bokning av BOLO-onboarding via Teams.",
      "",
      `Tiden är bokad: ${data.slot_label}`,
      `Skola/organisation: ${data.organization}`,
      "",
      "Teams-länken skickas i god tid innan mötet.",
      "",
      "Vänliga hälsningar,",
      "BOLO"
    ].join("\n");

    const internalResponse = await sendEmail(resendApiKey, {
      from,
      to,
      reply_to: data.email,
      subject: bookingSubject,
      text: bookingText
    });

    if (!internalResponse.ok) {
      const details = await internalResponse.text();
      return json({ ok: false, error: "Internal booking email failed", details }, 502);
    }

    const confirmationResponse = await sendEmail(resendApiKey, {
      from,
      to: data.email,
      reply_to: to,
      subject: confirmationSubject,
      text: confirmationText
    });

    if (!confirmationResponse.ok) {
      const details = await confirmationResponse.text();
      return json({ ok: false, error: "Confirmation email failed", details }, 502);
    }

    return json({ ok: true });
  } catch (error) {
    return json({ ok: false, error: error.message || "Unknown error" }, 500);
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function sendEmail(apiKey, payload) {
  return fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "https://bolowriter.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
