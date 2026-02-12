// functions/api/_posters.js

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fetchJsonAsset(env, url) {
  const req = new Request(url);
  if (env?.ASSETS?.fetch) {
    const res = await env.ASSETS.fetch(req);
    if (!res.ok) throw new Error(`Failed to fetch asset ${url}: ${res.status}`);
    return await res.json();
  }
  const res = await fetch(req);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return await res.json();
}

export async function loadPosters(request, env) {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  // In Pages, static assets are available directly. We fetch posters.json from public/data.
  return await fetchJsonAsset(env, `${origin}/data/posters.json`);
}

export async function findPosterById(request, env, posterId) {
  const data = await loadPosters(request, env);
  const posters = data?.posters || [];
  return posters.find((p) => p.id === posterId) || null;
}

// Map size keys to EXACT tokens used in your R2 object names
export function sizeToken(sizeKey) {
  const s = String(sizeKey || "").toLowerCase();
  if (s === "a2") return "A2_(420x594mm)";
  if (s === "a3") return "A3_(297x420mm)";
  if (s === "12x18") return "12x18_in";
  if (s === "18x24") return "18x24_in";
  throw new Error(`Unsupported size: ${sizeKey}`);
}

export function normalizeMode(mode) {
  return String(mode || "STRICT").toUpperCase() === "ART" ? "ART" : "STRICT";
}

// EXACT match to your R2 filenames:
// fileBase + "_" + token + "_" + MODE + ".png"
export function buildPrintFilename(fileBase, sizeKey, mode) {
  const m = normalizeMode(mode);
  const token = sizeToken(sizeKey);
  return `${fileBase}_${token}_${m}.png`;
}

// Build relative object path in R2 (prefix + filename)
// e.g. exports/world_history_25_icons_18x24_in_STRICT.png
export function buildPrintPath(poster, sizeKey, mode) {
  const base = poster?.fileBase;
  if (!base) throw new Error(`Poster is missing fileBase (posterId=${poster?.id || "?"})`);

  const dir = String(poster?.printDir || "").replace(/^\/+|\/+$/g, "");
  const filename = buildPrintFilename(base, sizeKey, mode);

  return dir ? `${dir}/${filename}` : filename;
}

export { json };
