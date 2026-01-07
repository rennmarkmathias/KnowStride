import { requireClerkAuth } from "./_auth";

/**
 * GET /api/library
 * Returns:
 *  - 401 if not logged in
 *  - { hasAccess: true, plan, access_until } if active
 *  - { hasAccess: false } otherwise
 */
export async function onRequestGet(context) {
  const { request, env } = context;

  // ✅ Strict auth check (prevents D1 binds with undefined)
  const auth = await requireClerkAuth(request, env);
  if (!auth || !auth.userId) {
    return new Response(JSON.stringify({ error: "Not logged in" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // ✅ Also guard DB binding (defensive)
  if (!env.DB) {
    return new Response(JSON.stringify({ error: "DB binding missing" }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const userId = auth.userId;

  // Fetch access row
  const row = await env.DB.prepare(
    `SELECT user_id, start_time, access_until, plan, status
     FROM access
     WHERE user_id = ?`
  )
    .bind(userId)
    .first();

  // No subscription yet
  if (!row || row.status !== "active") {
    return new Response(JSON.stringify({ hasAccess: false }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // Active subscription
  return new Response(
    JSON.stringify({
      hasAccess: true,
      plan: row.plan,
      access_until: row.access_until,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    }
  );
}
