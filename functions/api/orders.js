import { requireClerkAuth } from "./_auth";

/**
 * Fetch email addresses for the authenticated Clerk user (server-side).
 * This lets us safely include guest orders (stored by email) in the same account view.
 */
async function getClerkEmails(env, userId) {
  const secret = env.CLERK_SECRET_KEY;
  if (!secret) throw new Error("Missing CLERK_SECRET_KEY");

  const res = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
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

  // Prefer primary email first (if present)
  const primaryId = user.primary_email_address_id;
  const primary = (user.email_addresses || []).find((e) => e.id === primaryId)?.email_address;
  if (primary) {
    return [primary, ...emails.filter((x) => x !== primary)];
  }

  return emails;
}

export async function onRequestGet({ request, env }) {
  const userId = await requireClerkAuth(request, env);

  if (!env.DB) {
    return new Response(JSON.stringify({ ok: false, error: "DB binding missing" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const emails = await getClerkEmails(env, userId);
    const email = emails[0] || null;

    // Show:
    //  - all orders created while logged in (clerk_user_id matches)
    //  - plus guest orders (no clerk_user_id) where email matches any of the user's emails
    // This is the "standard" UX people expect.
    const placeholders = emails.map(() => "?").join(", ");
    const sql = `
      SELECT
        poster_title, size, paper, mode, amount_total, currency, status, created_at,
        prodigi_order_id, prodigi_status, tracking_number, tracking_url, shipped_at
      FROM orders
      WHERE clerk_user_id = ?
         OR (clerk_user_id IS NULL AND email IN (${placeholders || "NULL"}))
      ORDER BY created_at DESC
      LIMIT 50
    `;

    const bindings = [userId, ...emails];
    const { results } = await env.DB.prepare(sql).bind(...bindings).all();

    return new Response(
      JSON.stringify({ ok: true, orders: results, matchedByEmail: Boolean(email) }),
      { headers: { "content-type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: err?.message || String(err) }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
}
