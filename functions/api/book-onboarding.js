// functions/api/book-onboarding.js
// Cloudflare Pages Function endpoint used by the onboarding popup.
// Sends one booking email to BOLO and one confirmation email to the person who booked.
// Stores booked slots in Cloudflare KV so booked times disappear from the popup.
// Environment variables:
//   RESEND_API_KEY=...
//   BOOKING_FROM=BOLO <info@bolowriter.com>
//   BOOKING_TO=info@bolowriter.com
// Binding:
//   BOOKING_KV = Cloudflare KV namespace binding

export async function onRequestGet(context) {
  try {
    const { env } = context;

    if (!env.BOOKING_KV) {
      return json({ ok: true, booked_slots: [] });
    }

    const list = await env.BOOKING_KV.list({ prefix: "slot:" });
    const booked_slots = list.keys.map((item) => item.name.replace(/^slot:/, ""));

    return json({ ok: true, booked_slots });
  } catch (error) {
    return json({ ok: false, error: error.message || "Unknown error" }, 500);
  }
}

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

    if (!env.BOOKING_KV) {
      return json({ ok: false, error: "BOOKING_KV binding is not configured" }, 500);
    }

    const slotKey = `slot:${data.slot}`;
    const existingBooking = await env.BOOKING_KV.get(slotKey);
    if (existingBooking) {
      return json({ ok: false, error: "Slot already booked" }, 409);
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

    await env.BOOKING_KV.put(slotKey, JSON.stringify({
      slot: data.slot,
      slot_label: data.slot_label,
      name: data.name,
      email: data.email,
      organization: data.organization,
      role: data.role || "",
      message: data.message || "",
      source: data.source || "",
      created_at: new Date().toISOString()
    }));

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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}
