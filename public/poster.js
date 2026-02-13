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

function normalizeMode(mode) {
  return String(mode || "STRICT").toUpperCase() === "ART" ? "ART" : "STRICT";
}

function sizeTokenForPreview(sizeKey) {
  const s = String(sizeKey || "").toLowerCase();
  if (s === "12x18") return "12x18";
  if (s === "18x24") return "18x24";
  if (s === "a2") return "A2_(420x594mm)";
  if (s === "a3") return "A3_(297x420mm)";
  return s;
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

// Only show sizes that exist (have a price) for the selected paper.
function sizeOptionsForPaper(poster, paperKey) {
  const available = [];
  for (const s of SIZES) {
    if (priceFor(poster, paperKey, s.key) != null) available.push(s);
  }
  return available;
}

// Build preview URL based on your actual filenames in /public/previews
function buildPreviewUrl(poster, sizeKey, modeKey) {
  const size = String(sizeKey || "").toLowerCase();
  const mode = normalizeMode(modeKey);

  // 1) Explicit override (if present)
  const vKey = `${size}_${mode}`;
  const explicit = poster?.variantPreviews?.[vKey];
  if (explicit) return explicit;

  // 2) Standard pattern in your repo:
  // /previews/<fileBase>_<SIZE>_in_<MODE>_fixed.jpg
  const base = poster?.fileBase;
  if (base) {
    const token = sizeTokenForPreview(size);
    return `/previews/${base}_${token}_in_${mode}_fixed.jpg`;
  }

  // 3) Fallback
  return poster?.previewUrl || "";
}

/* ---------------------------
   Meta Pixel helpers/events
---------------------------- */
const fbqSafe = (...args) => {
  try { if (typeof window.fbq === "function") window.fbq(...args); } catch {}
};

// Pick a stable id for Meta events note: stable id per poster
function contentIdForPoster(p) {
  return String(p?.id ?? p?.slug ?? p?.fileBase ?? p?.title ?? "");
}

function trackViewContent({ poster, value, currency }) {
  fbqSafe("track", "ViewContent", {
    content_ids: [contentIdForPoster(poster)],
    content_name: poster?.title || "",
    content_category: poster?.category || "",
    content_type: "product",
    value: Number(value) || 0,
    currency: currency || "USD"
  });
}

function trackInitiateCheckout({ poster, value, currency }) {
  fbqSafe("track", "InitiateCheckout", {
    content_ids: [contentIdForPoster(poster)],
    content_name: poster?.title || "",
    content_category: poster?.category || "",
    content_type: "product",
    value: Number(value) || 0,
    currency: currency || "USD",
    num_items: 1
  });
}

/**
 * Save last checkout context for succes.html to read (optional Purchase tracking)
 */
function stashCheckoutForSuccess({ poster, value, currency }) {
  try {
    sessionStorage.setItem("ks_last_checkout", JSON.stringify({
      content_ids: [contentIdForPoster(poster)],
      content_name: poster?.title || "",
      value: Number(value) || 0,
      currency: currency || "USD",
      num_items: 1
    }));
  } catch {}
}

function render(poster) {
  const page = $("posterPage");
  if (!page) return;

  const title = escapeHtml(poster.title || "Poster");
  const cat = escapeHtml(poster.category || "");
  const tag = escapeHtml(poster.tag || "");

  let defaultPaper = "standard";
  if (!poster?.prices?.standard || Object.keys(poster.prices.standard).length === 0) {
    defaultPaper = "fineart";
  }

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

  const initialPreviewUrl = buildPreviewUrl(poster, defaultSize, defaultMode);

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

        <!-- ✅ MOVED UP for mobile conversion: Price + CTA comes early -->
        <div class="buy-row" style="margin-top:12px;">
          <div>
            <div class="muted small">Total</div>
            <div class="price" id="price">—</div>
          </div>
          <button class="btn" id="buyBtn" type="button">Checkout with Stripe</button>
        </div>

        <div class="muted small" style="margin-top:10px;">
          Free shipping · Tracking included · No frames
        </div>

        <!-- Layout first -->
        <div class="buy-block" style="margin-top:18px;">
          <div class="buy-label">Layout</div>
          <div class="radio-grid" role="radiogroup" aria-label="Layout">${modeOptions}</div>
        </div>

        <div class="buy-block">
          <div class="buy-label">Size</div>
          <select class="select" id="sizeSelect" aria-label="Size"></select>
          <div id="sizeHint" class="muted small" style="margin-top:6px;"></div>
        </div>

        <div class="buy-block">
          <div class="buy-label">Paper</div>
          <div class="radio-grid" role="radiogroup" aria-label="Paper">${paperOptions}</div>
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

    let nextSize = selectedSize;
    if (!sizes.some((s) => s.key === nextSize)) {
      nextSize = sizes[0]?.key || "18x24";
    }

    sizeSelect.innerHTML = sizes
      .map((s) => `<option value="${s.key}" ${s.key === nextSize ? "selected" : ""}>${s.label}</option>`)
      .join("");

    if (sizeHint) {
      sizeHint.textContent = paperKey === "standard" ? "A2/A3: Fine Art" : "";
    }

    return nextSize;
  };

  // Initial sizes
  defaultSize = renderSizeSelect(defaultPaper, defaultSize);

  const getCurrentSelection = () => {
    const paper = document.querySelector('input[name="paper"]:checked')?.value || defaultPaper;
    const size = sizeSelect?.value || defaultSize;
    const mode = document.querySelector('input[name="mode"]:checked')?.value || defaultMode;
    return { paper, size, mode };
  };

  const getCurrentValue = () => {
    const { paper, size } = getCurrentSelection();
    const p = priceFor(poster, paper, size);
    return p == null ? 0 : p;
  };

  const formatUsd = (amount) => {
    // Keep it simple: "$29 USD". If you later add cents, you can swap this for Intl.NumberFormat.
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return "—";
    return `$${n} USD`;
  };

  const updatePrice = () => {
    const v = getCurrentValue();
    priceEl.textContent = formatUsd(v);
  };

  const updatePreview = () => {
    const { size, mode } = getCurrentSelection();
    const next = buildPreviewUrl(poster, size, mode);

    if (previewImg && next && previewImg.getAttribute("src") !== next) {
      previewImg.setAttribute("src", next);
    }
  };

  // Fire ViewContent once on load (after initial price is computed)
  const fireViewContent = () => {
    const value = getCurrentValue();
    trackViewContent({ poster, value, currency: "USD" });
  };

  document.querySelectorAll('input[name="paper"]').forEach((el) => {
    el.addEventListener("change", () => {
      const paper = document.querySelector('input[name="paper"]:checked')?.value || defaultPaper;
      const currentSize = sizeSelect?.value || defaultSize;

      const nextSize = renderSizeSelect(paper, currentSize);
      if (sizeSelect) sizeSelect.value = nextSize;

      updatePrice();
      updatePreview();
      fireViewContent();
    });
  });

  sizeSelect?.addEventListener("change", () => {
    updatePrice();
    updatePreview();
    fireViewContent();
  });

  document.querySelectorAll('input[name="mode"]').forEach((el) => {
    el.addEventListener("change", () => {
      updatePreview();
      fireViewContent();
    });
  });

  buyBtn?.addEventListener("click", () => {
    void (async () => {
      const { paper, size, mode } = getCurrentSelection();
      const value = getCurrentValue();

      // Track InitiateCheckout immediately on click
      trackInitiateCheckout({ poster, value, currency: "USD" });

      // Store for success page to track Purchase (optional but useful)
      stashCheckoutForSuccess({ poster, value, currency: "USD" });

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
        buyBtn.textContent = "Checkout with Stripe";
        alert(data?.error || "Could not start checkout. Check your Stripe env vars and try again.");
        return;
      }

      window.location.href = data.url;
    })();
  });

  updatePrice();
  updatePreview();
  fireViewContent();
}

async function main() {
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
