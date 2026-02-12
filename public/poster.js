/*
  Poster detail page (static).
  Reads /data/posters.json, finds poster by ?slug, renders variant pickers.
  "Buy" is a placeholder for now — we'll wire to Stripe/Prodigi next.
*/

const $ = (id) => document.getElementById(id);

const SIZES = [
  { key: "a3", label: "A3 (297×420 mm)" },
  { key: "a2", label: "A2 (420×594 mm)" },
  { key: "12x18", label: "12×18 in" },
  { key: "18x24", label: "18×24 in" }
];

const PAPERS = [
  { key: "standard", label: "Standard", hint: "Clean poster stock" },
  { key: "fineart", label: "Fine Art", hint: "Enhanced matte" }
];

const MODES = [
  { key: "STRICT", label: "Strict", hint: "Uniform grid" },
  { key: "ART", label: "Art", hint: "Slight variation" },
];

function getParam(name) {
  return new URL(window.location.href).searchParams.get(name) || "";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function priceFor(poster, paperKey, sizeKey) {
  const paper = poster?.prices?.[paperKey] || {};
  const v = Number(paper?.[sizeKey]);
  return Number.isFinite(v) ? v : null;
}

async function getClerkTokenIfSignedIn() {
  try {
    if (!window.Clerk) return null;
    await window.Clerk.load();
    if (!window.Clerk.user || !window.Clerk.session) return null;
    return await window.Clerk.session.getToken();
  } catch {
    return null;
  }
}

// NEW: build size options based on selected paper.
// Standard: only show sizes that exist (in your case 12x18 and 18x24).
function sizeOptionsForPaper(poster, paperKey) {
  const available = [];
  for (const s of SIZES) {
    if (priceFor(poster, paperKey, s.key) != null) {
      available.push(s);
    }
  }
  return available;
}

function render(poster) {
  const page = $("posterPage");
  if (!page) return;

  const title = escapeHtml(poster.title || "Poster");
  const cat = escapeHtml(poster.category || "");
  const tag = escapeHtml(poster.tag || "");

  // Defaults: pick first valid combo (prefer standard, but fall back if needed)
  let defaultPaper = "standard";
  if (!poster?.prices?.standard || Object.keys(poster.prices.standard).length === 0) {
    defaultPaper = "fineart";
  }

  // Default size should be valid for the chosen paper
  let defaultSize = "18x24";
  const defaultMode = "STRICT";

  const initialSizes = sizeOptionsForPaper(poster, defaultPaper);
  if (initialSizes.length > 0) defaultSize = initialSizes[0].key;

  const paperOptions = PAPERS.map(
    (p) => `
      <label class="radio">
        <input type="radio" name="paper" value="${p.key}" ${p.key === defaultPaper ? "checked" : ""} />
        <span class="radio-main">
          <span class="radio-title">${p.label}</span>
          <span class="radio-sub">${p.hint}</span>
        </span>
      </label>
    `.trim()
  ).join("");

  // We will render size <option>s dynamically after render (based on paper).
  const modeOptions = MODES.map(
    (m) => `
      <label class="radio">
        <input type="radio" name="mode" value="${m.key}" ${m.key === defaultMode ? "checked" : ""} />
        <span class="radio-main">
