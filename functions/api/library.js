import { requireClerkAuth } from "./_auth";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequestGet({ request, env }) {
  try {
    // IMPORTANT: _auth.js expects (request, env) — not an object
    const auth = await requireClerkAuth(request, env);

    const userId = auth.userId;
    const email = auth.email || null;

    // 1) Check access in D1
    // Your table has: status (e.g. "active") and access_until stored in milliseconds.
    const nowMs = Date.now();

    const row = await env.DB.prepare(
      `SELECT status, access_until
       FROM access
       WHERE user_id = ?1
       ORDER BY access_until DESC
       LIMIT 1`
    )
      .bind(userId)
      .first();

    const accessGranted =
      !!row &&
      String(row.status || "").toLowerCase() === "active" &&
      Number(row.access_until || 0) > nowMs;

    if (!accessGranted) {
      return json({ accessGranted: false, email });
    }

    // 2) Build library items from /public/blocks/manifest.json
    const url = new URL(request.url);
    const manifestRes = await fetch(`${url.origin}/blocks/manifest.json`, {
      headers: { "Cache-Control": "no-store" },
    });

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

    return json({ accessGranted: true, email, items });
  } catch (err) {
    const msg = err?.message || String(err);
    const status = msg.toLowerCase().includes("unauthorized") ? 401 : 500;
    return json({ error: msg }, status);
  }
}
