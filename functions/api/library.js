import { requireClerkAuth } from "./_auth";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fetchManifest(request, env) {
  const url = new URL(request.url);
  const manifestUrl = `${url.origin}/blocks/manifest.json`;
  const manifestReq = new Request(manifestUrl);

  // Prefer Pages static assets binding if available
  if (env?.ASSETS?.fetch) {
    return env.ASSETS.fetch(manifestReq);
  }
  // Fallback (should still work on Pages)
  return fetch(manifestReq);
}

export async function onRequestGet({ request, env }) {
  try {
    // ✅ IMPORTANT: _auth.js expects (request, env) — not an object
    const auth = await requireClerkAuth(request, env);

    const userId = auth?.userId || null;

    // If not signed in, return a non-error payload (keeps UI calm)
    if (!userId) {
      return json({
        accessGranted: false,
        reason: "not_signed_in",
        userId: null,
      });
    }

    // 1) Check access in D1
    const nowSec = Math.floor(Date.now() / 1000);

    const row = await env.DB.prepare(
      `SELECT status, access_until
       FROM access
       WHERE user_id = ?1
       ORDER BY access_until DESC
       LIMIT 1`
    )
      .bind(userId)
      .first();

    let accessGranted = false;

    if (row) {
      let until = Number(row.access_until);

      // Normalize ms → sec if needed
      if (until > 1e12) until = Math.floor(until / 1000);

      accessGranted =
        String(row.status || "").toLowerCase() === "active" && until > nowSec;
    }

    if (!accessGranted) {
      return json({
        accessGranted: false,
        reason: "no_active_subscription",
        userId,
      });
    }

    // 2) Build library items from /public/blocks/manifest.json
    let latest = 1;
    try {
      const manifestRes = await fetchManifest(request, env);
      if (manifestRes.ok) {
        const manifest = await manifestRes.json();
        latest = Number(manifest.latest || 1);
      }
    } catch {
      // If manifest fails, still return at least #1
      latest = 1;
    }

    const items = Array.from({ length: latest }, (_, i) => {
      const n = i + 1;
      return {
        id: n,
        title: `KnowStride #${n}`,
        url: `/blocks/knowstride${n}.html`,
      };
    });

    return json({ accessGranted: true, userId, items });
  } catch (err) {
    const msg = err?.message || String(err);
    // Return JSON error but keep shape predictable
    return json({ accessGranted: false, error: msg }, 500);
  }
}
