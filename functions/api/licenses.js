import { requireClerkAuth } from "./_auth.js";

async function getClerkEmails(env, userId) {
  const secret = env.CLERK_SECRET_KEY;
  if (!secret) throw new Error("Missing CLERK_SECRET_KEY");

  const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Failed to fetch Clerk user: ${res.status} ${txt}`);
  }

  const user = await res.json();
  const emails = (user.email_addresses || [])
    .map((e) => e.email_address)
    .filter(Boolean);

  const primaryId = user.primary_email_address_id;
  const primary = (user.email_addresses || []).find((e) => e.id === primaryId)?.email_address;
  if (primary) return [primary, ...emails.filter((x) => x !== primary)];
  return emails;
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

export async function onRequestGet({ request, env }) {
  const auth = await requireClerkAuth(request, env);
  const userId = auth?.userId || null;

  if (!userId) {
    return json({ ok: false, error: "Not authenticated" }, { status: 401 });
  }
  if (!env.DB) {
    return json({ ok: false, error: "DB binding missing" }, { status: 500 });
  }

  try {
    const emails = await getClerkEmails(env, userId);
    const placeholders = emails.map(() => "?").join(", ");

    const sql = `
      SELECT
        id,
        created_at,
        email,
        clerk_user_id,
        plan,
        period_months,
        seats,
        status,
        issued_at,
        expires_at,
        license_key,
        stripe_session_id,
        stripe_invoice_url
      FROM licenses
      WHERE clerk_user_id = ?
         OR (clerk_user_id IS NULL AND email IN (${placeholders || "NULL"}))
      ORDER BY created_at DESC
      LIMIT 50
    `;

    const { results } = await env.DB.prepare(sql).bind(userId, ...emails).all();
    return json({ ok: true, licenses: results || [] });
  } catch (err) {
    return json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}
