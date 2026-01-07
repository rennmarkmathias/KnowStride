import { requireClerkAuth } from "./_auth";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestGet({ request, env }) {
  try {
    // ✅ Viktigt: requireClerkAuth tar ett objekt { request, env }
    const auth = await requireClerkAuth({ request, env });

    const userId = auth.userId;

    // 1) Läs access från D1
    const nowSec = Math.floor(Date.now() / 1000);

    // Plocka senaste raden för användaren (ifall ni råkat få flera)
    const row = await env.DB.prepare(
      `SELECT user_id, status, access_until, plan, stripe_customer_id, stripe_subscription_id
       FROM access
       WHERE user_id = ?1
       ORDER BY access_until DESC
       LIMIT 1`
    )
      .bind(userId)
      .first();

    // Normalisera access_until (ms eller sek)
    let untilSec = null;
    if (row?.access_until != null) {
      const raw = Number(row.access_until);
      untilSec = raw > 1e12 ? Math.floor(raw / 1000) : raw; // ms -> sec
    }

    const status = row?.status ? String(row.status).toLowerCase() : null;

    const accessGranted = Boolean(
      row &&
        status === "active" &&
        typeof untilSec === "number" &&
        untilSec > nowSec
    );

    if (!accessGranted) {
      // ✅ Returnera tydlig orsak + debug så vi kan se mismatch direkt i Network
      return json(
        {
          accessGranted: false,
          reason: !row
            ? "no_row_for_user"
            : status !== "active"
              ? "status_not_active"
              : "expired_or_invalid_time",
          debug: {
            userId,
            nowSec,
            dbRow: row || null,
            computed: { status, untilSec },
          },
        },
        200
      );
    }

    // 2) Bygg items från manifest
    const url = new URL(request.url);
    const manifestReq = new Request(`${url.origin}/blocks/manifest.json`);

    // env.ASSETS finns normalt på Pages Functions. Om den saknas, fallback till vanlig fetch.
    const manifestRes = env.ASSETS?.fetch
      ? await env.ASSETS.fetch(manifestReq)
      : await fetch(manifestReq);

    let latest = 1;
    if (manifestRes?.ok) {
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
      items,
      debug: {
        nowSec,
        dbRow: row,
        computed: { status, untilSec },
      },
    });
  } catch (err) {
    const msg = err?.message || String(err);
    const status = msg.toLowerCase().includes("unauthorized") ? 401 : 500;
    return json({ error: msg }, status);
  }
}
