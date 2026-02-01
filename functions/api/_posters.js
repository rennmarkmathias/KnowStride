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
  const poster = posters.find((p) => p.id === posterId);
  return poster || null;
}

// Filnamnslogik enligt din konvention.
// sizeKey: "a2" | "a3" | "12x18" | "18x24"
// mode: "STRICT" | "ART"
export function buildPrintFilename(fileBase, sizeKey, mode) {
  const m = String(mode || "STRICT").toUpperCase() === "ART" ? "ART" : "STRICT";
  const s = String(sizeKey || "").toLowerCase();

  if (s === "a2") return `${fileBase}_A2_420x594mm_${m}.png`;
  if (s === "a3") return `${fileBase}_A3_297x420mm_${m}.png`;
  if (s === "12x18") return `${fileBase}_12x18_in_${m}.png`;
  if (s === "18x24") return `${fileBase}_18x24_in_${m}.png`;

  throw new Error(`Unsupported size: ${sizeKey}`);
}

export function buildPrintUrl(origin, poster, sizeKey, mode) {
  const base = poster?.fileBase;
  if (!base) throw new Error(`Poster is missing fileBase (posterId=${poster?.id || "?"})`);
  const dir = poster?.printDir || "/prints";
  const filename = buildPrintFilename(base, sizeKey, mode);
  return `${origin}${dir}/${encodeURIComponent(filename)}`;
}

export { json };
