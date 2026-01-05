import { requireClerkAuth } from "./_auth";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  const auth = await requireClerkAuth(request, env);
  if (!auth) return json({ error: "Not logged in." }, 401);

  const nowMs = Date.now();

  // Paid-status kommer från access-tabellen (skrivs av stripe-webhook.js)
  const access = await env.DB.prepare(
    "SELECT start_time, access_until FROM access WHERE user_id = ?"
  ).bind(auth.userId).first();

  const hasPaid = !!access && Number(access.access_until) > nowMs;

  if (!hasPaid) {
    return json({
      startedAt: access?.start_time ? new Date(Number(access.start_time)).toISOString() : null,
      unlockedCount: 0,
      firstAvailable: 0,
      retention: 52,
      totalBlocksAvailable: 0,
      blocks: [],
      hasPaid: false,
    });
  }

  const startedAt = new Date(Number(access.start_time));
  const now = new Date(nowMs);

  // 1 block unlock per 7 days from start_time
  const days = Math.floor((now - startedAt) / (1000 * 60 * 60 * 24));
  const unlockedCount = Math.max(1, Math.floor(days / 7) + 1);

  const retention = 52;
  const firstAvailable = Math.max(1, unlockedCount - retention + 1);

  // Total blocks available (manifest)
  let totalBlocksAvailable = unlockedCount;
  try {
    const manifestUrl = new URL("/blocks/manifest.json", url);
    const m = await fetch(manifestUrl.toString(), { cf: { cacheTtl: 300, cacheEverything: true } });
    if (m.ok) {
      const j = await m.json();
      if (typeof j.latest === "number" && j.latest > 0) totalBlocksAvailable = j.latest;
    }
  } catch (_) {}

  const maxUnlocked = Math.min(unlockedCount, totalBlocksAvailable);

  const blocks = [];
  for (let n = maxUnlocked; n >= firstAvailable; n--) blocks.push({ number: n });

  // If specific block requested, return its HTML
  const blockParam = url.searchParams.get("block");
  if (blockParam) {
    const n = Number(blockParam);
    if (!Number.isFinite(n) || n < 1) return json({ error: "Invalid block number" }, 400);
    if (n < firstAvailable || n > maxUnlocked) return json({ error: "Not unlocked or not available" }, 403);

    const blockUrl = new URL(`/blocks/knowstride${n}.html`, url);
    const r = await fetch(blockUrl.toString(), { cf: { cacheTtl: 300, cacheEverything: true } });
    if (!r.ok) return json({ error: "Block file not found. Upload it to /public/blocks first." }, 404);

    const html = await r.text();
    return json({ html, block: n });
  }

  return json({
    startedAt: startedAt.toISOString(),
    unlockedCount: maxUnlocked,
    firstAvailable,
    retention,
    totalBlocksAvailable,
    blocks,
    hasPaid: true,
    accessUntil: new Date(Number(access.access_until)).toISOString(),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
