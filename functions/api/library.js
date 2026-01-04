export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);

  // ---- Auth ----
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return json({ error: "Missing Bearer token" }, 401);
  }
  const token = auth.slice("Bearer ".length).trim();

  // Validate the session token via Clerk
  const verify = await fetch("https://api.clerk.com/v1/sessions/verify", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${context.env.CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
  });

  if (!verify.ok) {
    return json({ error: "Invalid session" }, 401);
  }

  const v = await verify.json();
  const userId = v?.session?.user_id;
  if (!userId) return json({ error: "No user_id" }, 401);

  // ---- Load user record (KV) ----
  const key = `user:${userId}`;
  const raw = await context.env.USERS.get(key);
  const user = raw ? JSON.parse(raw) : null;

  const startedAt = user?.startedAt ? new Date(user.startedAt) : new Date();
  const now = new Date();

  // One block unlocks every 7 days from the user's start time.
  const days = Math.floor((now - startedAt) / (1000 * 60 * 60 * 24));
  const unlockedCount = Math.max(1, Math.floor(days / 7) + 1);

  // Retention policy: keep 52 most recent blocks accessible
  const retention = 52;
  const firstAvailable = Math.max(1, unlockedCount - retention + 1);

  // ---- Total blocks available (from a static manifest) ----
  let totalBlocksAvailable = unlockedCount;
  try {
    const manifestUrl = new URL("/blocks/manifest.json", url);
    const m = await fetch(manifestUrl.toString(), { cf: { cacheTtl: 300, cacheEverything: true } });
    if (m.ok) {
      const j = await m.json();
      if (typeof j.latest === "number" && j.latest > 0) totalBlocksAvailable = j.latest;
    }
  } catch (_) {
    // If manifest is missing, fall back to unlockedCount.
  }

  const maxUnlocked = Math.min(unlockedCount, totalBlocksAvailable);
  const blocks = [];
  for (let n = maxUnlocked; n >= firstAvailable; n--) blocks.push(n);

  // ---- If a specific block is requested, return its HTML ----
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
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
