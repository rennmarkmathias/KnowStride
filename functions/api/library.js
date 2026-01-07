import { requireClerkAuth } from "./_auth";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestGet({ request, env }) {
  try {
    const auth = await requireClerkAuth(request, env);

    // Viktigt: _auth.js returnerar { isSignedIn:false } istället för att throw:a
    if (!auth?.isSignedIn || !auth?.userId) {
      return json(
        { accessGranted: false, reason: "not_signed_in", userId: null, email: null },
        401
      );
    }

    const userId = auth.userId;
    const email = auth.email || null;

    // 1) Hämta senaste access-raden för användaren
    const row = await env.DB.prepare(
      `SELECT status, access_until, plan
       FROM access
       WHERE user_id = ?1
       ORDER BY access_until DESC
       LIMIT 1`
    )
      .bind(userId)
      .first();

    if (!row) {
      // Ingen rad i DB för denna Clerk-userId
      return json({
        accessGranted: false,
        reason: "no_row_for_user",
        userId,
        email,
      });
    }

    // access_until kan vara ms (t.ex. 1770266647000) eller sek (t.ex. 1770266647)
    let untilMs = Number(row.access_until || 0);
    if (untilMs > 0 && untilMs < 1e12) {
      // Ser ut som sekunder -> konvertera till ms
      untilMs *= 1000;
    }

    const statusStr = String(row.status || "").toLowerCase();
    const nowMs = Date.now();

    const isActive = statusStr === "active";
    const notExpired = untilMs > nowMs;

    const accessGranted = isActive && notExpired;

    if (!accessGranted) {
      const reason = !isActive ? "status_not_active" : "expired";
      return json({
        accessGranted: false,
        reason,
        userId,
        email,
        status: row.status ?? null,
        access_until: row.access_until ?? null,
        plan: row.plan ?? null,
        now: nowMs,
      });
    }

    // 2) Bygg biblioteket från /public/blocks/manifest.json
    const url = new URL(request.url);
    const manifestReq = new Request(`${url.origin}/blocks/manifest.json`);
    const manifestRes = await env.ASSETS.fetch(manifestReq);

    let latest = 1;
    if (manifestRes.ok) {
      const manifest = await manifestRes.json();
      latest = Number(manifest.latest || 1);
    }

    const items = Array.from({ length: latest }, (_, i) => {
      const n = i + 1;
      return {
        id: n,
        title: `KnowStride #${n}`,
        url: `/blocks/knowstride${n}.html`,
      };
    });

    return json({
      accessGranted: true,
      userId,
      email,
      plan: row.plan ?? null,
      items,
    });
  } catch (err) {
    const msg = err?.message || String(err);
    return json({ error: msg }, 500);
  }
}
