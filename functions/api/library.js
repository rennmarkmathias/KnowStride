import { requireClerkAuth } from "./_auth";

export async function onRequestGet(context) {
  const { request, env } = context;

  const auth = await requireClerkAuth(request, env);
  if (!auth) return new Response("Unauthorized", { status: 401 });

  const { userId } = auth;
  const db = env.DB;
  if (!db) return new Response("Missing DB binding", { status: 500 });

  const row = await db
    .prepare(`SELECT access_until, status FROM access WHERE user_id = ?`)
    .bind(userId)
    .first();

  const now = Date.now();

  const accessUntil = row?.access_until ? Number(row.access_until) : 0;
  const status = row?.status || "inactive";

  const hasAccess = status === "active" && accessUntil > now;

  return new Response(JSON.stringify({ hasAccess, accessUntil, status }), {
    headers: { "Content-Type": "application/json" },
  });
}
