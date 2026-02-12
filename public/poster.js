/*
  Poster detail page (static).
  Reads /data/posters.json, finds poster by ?slug, renders variant pickers.
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

// Build size options based on selected paper (only show sizes that exist / have a price).
function sizeOptionsForPaper(poster, paperKey) {
  const available = [];
  for (const s of SIZES) {
    if (priceFor(poster, paperKey, s.key) != null) {
      available.push(s);
    }
  }
  return available;
}

// --- NEW: Preview switching logic

function normalizeMode(mode) {
  return String(mode || "STRICT").toUpperCase() === "ART" ? "ART" : "STRICT";
}

// If we know the exact R2 filename (via variantFiles), we can guess the preview filename too.
function guessPreviewFromVariantFile(fileName) {
  if (!fileName) return null;
  const f = String(fileName);

  // Preferred: you often have "xxx.png" and preview "xxx_fixed.jpg"
  if (f.toLowerCase().endsWith(".png")) {
    return `/previews/${f.replace(/\.png$/i, "_fixed.jpg")}`;
  }

  // If someone stored the preview name directly, just use it
  if (f.startsWith("/previews/")) return f;
  return `/previews/${f}`;
}

function pickPreviewUrl(poster, sizeKey, modeKey) {
  const size = String(sizeKey || "").toLowerCase();
  const mode = normalizeMode(modeKey);

  // 1) Explicit variant preview mapping in posters.json
  const vKey = `${size}_${mode}`;
  const explicit = poster?.variantPreviews?.[vKey];
  if (explicit) return explicit;

  // 2) If we have a variant file name (R2 object), guess its preview file
  const vFile = poster?.variantFiles?.[vKey];
  const guessed = guessPreviewFromVariantFile(vFile);
  if (guessed) return guessed;

  // 3) Fallback: use the main preview
  return poster.previewUrl;
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

  const modeOptions = MODES.map(
    (m) => `
      <label class="radio">
        <input type="radio" name="mode" value="${m.key}" ${m.key === defaultMode ? "checked" : ""} />
        <span class="radio-main">
          <span class="radio-title">${m.label}</span>
          <span class="radio-sub">${m.hint}</span>
        </span>
      </label>
    `.trim()
  ).join("");

  // Initial preview
  const initialPreviewUrl = pickPreviewUrl(poster, defaultSize, defaultMode);

  page.innerHTML = `
    <section class="poster-split">
      <div class="poster-preview">
        <div class="poster-img poster-img--large">
          <img id="posterPreviewImg" src="${initialPreviewUrl}" alt="${title}" loading="eager" />
        </div>
      </div>

      <div class="poster-buy card">
        <div class="poster-kicker">
          <span class="badge">${cat}</span>
          ${tag ? `<span class="muted">${tag}</span>` : ""}
        </div>
        <h1 class="poster-h1">${title}</h1>
        <p class="muted">A black-and-white icon poster in a classic engraving style. The item list is rendered separately beneath the artwork.</p>

        <div class="buy-block">
          <div class="buy-label">Paper</div>
          <div class="radio-grid" role="radiogroup" aria-label="Paper">${paperOptions}</div>
        </div>

        <div class="buy-block">
          <div class="buy-label">Size</div>
          <select class="select" id="sizeSelect" aria-label="Size"></select>
          <div id="sizeHint" class="muted small" style="margin-top:6px;"></div>
        </div>

        <div class="buy-block" style="margin-top:4px;">
          <div class="buy-label">Layout</div>
          <div class="radio-grid" role="radiogroup" aria-label="Layout">${modeOptions}</div>
        </div>

        <div class="buy-row">
          <div>
            <div class="muted small">Total</div>
            <div class="price" id="price">—</div>
          </div>
          <button class="btn" id="buyBtn" type="button">Buy with Stripe</button>
        </div>

        <div class="muted small" style="margin-top:10px;">
          Free shipping · Tracking included · No frames
        </div>
      </div>
    </section>
  `;

  const sizeSelect = $("sizeSelect");
  const sizeHint = $("sizeHint");
  const priceEl = $("price");
  const buyBtn = $("buyBtn");
  const previewImg = $("posterPreviewImg");

  const renderSizeSelect = (paperKey, selectedSize) => {
    const sizes = sizeOptionsForPaper(poster, paperKey);

    // If selected size isn't available, choose the first available.
    let nextSize = selectedSize;
    if (!sizes.some((s) => s.key === nextSize)) {
      nextSize = sizes[0]?.key || "18x24";
    }

    sizeSelect.innerHTML = sizes
      .map((s) => `<option value="${s.key}" ${s.key === nextSize ? "selected" : ""}>${s.label}</option>`)
      .join("");

    // Tiny hint: show only when Standard is selected.
    if (sizeHint) {
      sizeHint.textContent = paperKey === "standard" ? "A2/A3: Fine Art" : "";
    }

    return nextSize;
  };

  // Update preview whenever size/mode changes
  const updatePreview = () => {
    const size = sizeSelect?.value || defaultSize;
    const mode = document.querySelector('input[name="mode"]:checked')?.value || defaultMode;
    const next = pickPreviewUrl(poster, size, mode);

    if (previewImg && next && previewImg.getAttribute("src") !== next) {
      previewImg.setAttribute("src", next);
    }
  };

  // Initial render of size select based on default paper
  defaultSize = renderSizeSelect(defaultPaper, defaultSize);

  const updatePrice = () => {
    const paper = document.querySelector('input[name="paper"]:checked')?.value || defaultPaper;
    const size = sizeSelect?.value || defaultSize;
    const p = priceFor(poster, paper, size);
    priceEl.textContent = p == null ? "—" : `$${p}`;
  };

  // Paper change: re-render sizes, then update price + preview
  document.querySelectorAll('input[name="paper"]').forEach((el) => {
    el.addEventListener("change", () => {
      const paper = document.querySelector('input[name="paper"]:checked')?.value || defaultPaper;
      const currentSize = sizeSelect?.value || defaultSize;

      const nextSize = renderSizeSelect(paper, currentSize);
      if (sizeSelect) sizeSelect.value = nextSize;

      updatePrice();
      updatePreview();
    });
  });

  // Size change: update price + preview
  sizeSelect?.addEventListener("change", () => {
    updatePrice();
    updatePreview();
  });

  // Mode change: update preview (and price unchanged)
  document.querySelectorAll('input[name="mode"]').forEach((el) => {
    el.addEventListener("change", () => {
      updatePreview();
    });
  });

  buyBtn?.addEventListener("click", () => {
    void (async () => {
      const paper = document.querySelector('input[name="paper"]:checked')?.value || defaultPaper;
      const size = sizeSelect?.value || defaultSize;
      const mode = document.querySelector('input[name="mode"]:checked')?.value || "STRICT";

      buyBtn.disabled = true;
      buyBtn.textContent = "Redirecting…";

      const token = await getClerkTokenIfSignedIn();

      const res = await fetch("/api/create-poster-checkout-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          posterId: poster.id,
          size,
          paper,
          mode,
          quantity: 1,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.url) {
        buyBtn.disabled = false;
        buyBtn.textContent = "Buy with Stripe";
        alert(data?.error || "Could not start checkout. Check your Stripe env vars and try again.");
        return;
      }

      window.location.href = data.url;
    })();
  });

  updatePrice();
  updatePreview();
}

async function main() {
  const y = $("year");
  if (y) y.textContent = String(new Date().getFullYear());

  const slug = getParam("slug");
  const page = $("posterPage");

  if (!slug) {
    if (page) page.innerHTML = `<div class="card"><strong>Missing poster</strong><div class="muted">No slug provided.</div></div>`;
    return;
  }

  let posters = [];
  try {
    const res = await fetch("/data/posters.json", { cache: "no-store" });
    const data = await res.json();
    posters = Array.isArray(data.posters) ? data.posters : [];
  } catch {
    posters = [];
  }

  const poster = posters.find((p) => p.slug === slug);
  if (!poster) {
    if (page) page.innerHTML = `<div class="card"><strong>Not found</strong><div class="muted">This poster does not exist (yet).</div></div>`;
    return;
  }

  render(poster);
}

main();
