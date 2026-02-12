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
    if (!res.ok) throw new Error(`Failed to load asset: ${url}`);
    return res.json();
  }
  const res = await fetch(req);
  if (!res.ok) throw new Error(`Failed to load asset: ${url}`);
  return res.json();
}

export async function loadPosters(request, env) {
  const url = new URL(request.url);
  const postersUrl = `${url.origin}/data/posters.json`;
  const data = await fetchJsonAsset(env, postersUrl);
  return Array.isArray(data?.posters) ? data.posters : [];
}

export async function findPosterById(request, env, posterId) {
  const posters = await loadPosters(request, env);
  return posters.find((p) => p.id === posterId) || null;
}

// Matchar exakt dina R2-filnamn:
function sizeToken(sizeKey) {
  const s = String(sizeKey || "").toLowerCase();
  if (s === "a2") return "A2_(420x594mm)";
  if (s === "a3") return "A3_(297x420mm)";
  if (s === "12x18") return "12x18_in";
  if (s === "18x24") return "18x24_in";
  throw new Error(`Unsupported size: ${sizeKey}`);
}

function normalizeMode(mode) {
  return String(mode || "STRICT").toUpperCase() === "ART" ? "ART" : "STRICT";
}

export function buildPrintFilename(poster, sizeKey, mode) {
  const base = poster?.fileBase;
  if (!base) throw new Error(`Poster is missing fileBase (posterId=${poster?.id || "?"})`);

  const m = normalizeMode(mode);
  const token = sizeToken(sizeKey);

  // Optional override per variant (som du har för world_history 18x24 ART)
  const variantKey = `${String(sizeKey).toLowerCase()}_${m}`;
  const override = poster?.variantFiles?.[variantKey];
  if (override) return override;

  return `${base}_${token}_${m}.png`;
}

// Returnerar relativ R2-path (som webhooken bygger full URL av via PRINTS_BASE_URL)
export function buildPrintPath(poster, sizeKey, mode) {
  const dir = String(poster?.printDir || "").replace(/^\/+|\/+$/g, "");
  const filename = buildPrintFilename(poster, sizeKey, mode);
  return dir ? `${dir}/${filename}` : filename;
}

export { json };
