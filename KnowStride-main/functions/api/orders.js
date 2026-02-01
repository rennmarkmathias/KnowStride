import { requireClerkAuth } from "./_auth";
import { json } from "./_posters";

// Returns poster orders for the currently signed-in Clerk user.
export async function onRequestGet(context) {
  try {
    const { request, env } = context;

    if (!env.DB) return json({ error: "Missing DB binding" }, 500);

    const { userId } = await requireClerkAuth(request, env);

    const { results } = await env.DB.prepare(
      `SELECT
        id,
        created_at,
        poster_id,
        poster_title,
        size,
        paper,
        mode,
        currency,
        amount_total,
        status,
        prodigi_order_id
      FROM orders
      WHERE clerk_user_id = ?
      ORDER BY created_at DESC
      LIMIT 200`
    )
      .bind(userId)
      .all();

    return json({ orders: results || [] });
  } catch (err) {
    return json({ error: err?.message || String(err) }, 401);
  }
}
