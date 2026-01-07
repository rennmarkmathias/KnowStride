import { requireClerkAuth } from "./_auth";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestGet({ request, env }) {
  try {
    const auth = await requireClerkAuth({ request, env });

    const userId = auth.userId;
    const email = auth.email || null;

    // 1) Check access in D1
    // Table uses `status` (e.g. "active"), not `active` (1/0)
    // access_until may be milliseconds -> normalize to seconds
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

      // If access_until is in milliseconds (very large), convert to seconds.
      if (until > 1e12) {
        until = Math.floor(until / 1000);
      }

      accessGranted =
        String(row.status).toLowerCase() === "active" && until > nowSec;
    }

    if (!accessGranted) {
      return json({ accessGranted: false, email });
    }

    // 2) Build library items from /public/blocks/manifest.json
    // IMPORTANT: Do NOT use env.ASSETS here (not guaranteed to exist).
    // Fetch the static asset from the same origin instead.
    const url = new URL(request.url);

    let latest = 1;
    try {
      const manifestRes = await fetch(`${url.origin}/blocks/manifest.json`, {
        headers: { "Accept": "application/json" },
      });

      if (manifestRes.ok) {
        const manifest = await manifestRes.json();
        latest = Number(manifest.latest || 1);
      }
    } catch {
      // If manifest is missing or fails, we still return a sane default (latest = 1)
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
