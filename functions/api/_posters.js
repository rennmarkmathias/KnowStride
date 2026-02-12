/*
  Poster detail page (static).
  Reads /data/posters.json, finds poster by ?slug, renders variant pickers.
*/
const $ = (id) => document.getElementById(id);

const SIZES = [
  { key: "a3", label: "A3 (297×420 mm)" },
  { key: "a2", label: "A2 (420×594 mm)" },
  { key: "12x18", label: "12×18 in" },
  { key: "18x24", label: "18×24 in" },
];

const PAPERS = [
  { key: "standard", label: "Standard", hint: "Classic matte" },
  { key: "fineart", label: "Fine Art", hint: "Premium archival paper" },
];

const MODES = [
  { key: "STRICT", label: "Strict", hint: "Poster-tight (may crop)" },
  { key: "ART", label: "Art", hint: "Preserve whole image" },
];

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));

function sizeToken(sizeKey) {
  const s = String(sizeKey || "").toLowerCase();
  if (s === "a2") return "A2_(420x594mm)";
  if (s === "a3") return "A3_(297x420mm)";
  if (s === "12x18") return "12x18_in";
  if (s === "18x24") return "18x24_in";
  return s;
}

function normalizeMode(mode) {
  return String(mode || "STRICT").toUpperCase() === "ART" ? "ART" : "STRICT";
}

function buildPreviewUrl(poster, sizeKey, mode) {
  const base = poster.fileBase;
  const token = sizeToken(sizeKey);
  const m = normalizeMode(mode);
  // Your preview files are: fileBase + "_" + token + "_" + MODE + "_fixed.jpg"
  return `/previews/${base}_${token}_${m}_fixed.jpg`;
}

function getVariantPrice(poster, paper, size) {
  return Number(poster?.prices?.[paper]?.[size] ?? 0);
}

function renderRadioGroup({ name, options, selected, onChange, disabledKeys = new Set() }) {
  return options
    .map((o) => {
      const checked = o.key === selected ? "checked" : "";
      const disabled = disabledKeys.has(o.key) ? "disabled" : "";
      return `
        <label class="radio ${disabled ? "is-disabled" : ""}">
          <input type="radio" name="${name}" value="${o.key}" ${checked} ${disabled} />
          <span class="radio-ui">
            <span class="radio-label">${escapeHtml(o.label)}</span>
            ${o.hint ? `<span class="radio-sub">${escapeHtml(o.hint)}</span>` : ""}
          </span>
        </label>
      `.trim();
    })
    .join("");
}

async function main() {
  const page = $("page");
  const params = new URLSearchParams(location.search);
  const slug = params.get("slug");

  const res = await fetch("/data/posters.json");
  const data = await res.json();
  const posters = data.posters || [];
  const poster = posters.find((p) => p.slug === slug) || posters[0];

  if (!poster) {
    page.innerHTML = `<p class="muted">Poster not found.</p>`;
    return;
  }

  const title = escapeHtml(poster.title);
  const cat = escapeHtml(poster.category || "");
  const tag = escapeHtml(poster.tag || "");

  // Defaults
  let size = "18x24";
  let paper = "fineart";
  let mode = "STRICT";

  function recomputeDefaults() {
    // pick first valid paper/size combo based on prices
    // prefer fineart if available
    const papers = ["fineart", "standard"];
    const sizes = ["18x24", "12x18", "a2", "a3"];

    for (const p of papers) {
      for (const s of sizes) {
        if (getVariantPrice(poster, p, s) > 0) {
          paper = p;
          size = s;
          return;
        }
      }
    }
  }

  recomputeDefaults();

  page.innerHTML = `
    <section class="poster-split">
      <div class="poster-preview">
        <div class="poster-img poster-img--large">
          <img id="posterImg" src="${buildPreviewUrl(poster, size, mode)}" alt="${title}" loading="eager" />
        </div>
      </div>

      <div class="poster-buy card">
        <div class="poster-kicker">
          <span class="badge">${cat}</span>
          ${tag ? `<span class="muted">${tag}</span>` : ""}
        </div>
        <h1 class="poster-h1">${title}</h1>

        <div class="buy-section">
          <h3 class="buy-h3">Paper</h3>
          <div id="paperPick" class="radio-grid"></div>
        </div>

        <div class="buy-section">
          <h3 class="buy-h3">Size</h3>
          <div id="sizePick" class="radio-grid"></div>
        </div>

        <div class="buy-section">
          <h3 class="buy-h3">Mode</h3>
          <div id="modePick" class="radio-grid"></div>
        </div>

        <div class="buy-row">
          <div>
            <div class="muted">Price</div>
            <div id="price" class="price"></div>
          </div>
          <button id="buyBtn" class="btn-primary">Buy</button>
        </div>

        <p class="muted small">Shipping included. You’ll enter address at checkout.</p>
      </div>
    </section>
  `;

  const posterImg = $("posterImg");

  function updatePriceAndPreview() {
    const price = getVariantPrice(poster, paper, size);
    $("price").textContent = price > 0 ? `$${price.toFixed(0)}` : "—";
    posterImg.src = buildPreviewUrl(poster, size, mode);
  }

  function rerenderPickers() {
    // disable sizes that don't exist for chosen paper
    const disabledSizes = new Set();
    for (const s of SIZES) {
      if (getVariantPrice(poster, paper, s.key) <= 0) disabledSizes.add(s.key);
    }

    // disable papers that have no sizes at all
    const disabledPapers = new Set();
    for (const p of PAPERS) {
      const hasAny = SIZES.some((s) => getVariantPrice(poster, p.key, s.key) > 0);
      if (!hasAny) disabledPapers.add(p.key);
    }

    $("paperPick").innerHTML = renderRadioGroup({
      name: "paper",
      options: PAPERS,
      selected: paper,
      disabledKeys: disabledPapers,
    });

    $("sizePick").innerHTML = renderRadioGroup({
      name: "size",
      options: SIZES,
      selected: size,
      disabledKeys: disabledSizes,
    });

    $("modePick").innerHTML = renderRadioGroup({
      name: "mode",
      options: MODES,
      selected: mode,
    });

    // wire listeners
    document.querySelectorAll('input[name="paper"]').forEach((el) => {
      el.addEventListener("change", () => {
        paper = el.value;
        // if current size not available, pick first available size
        if (getVariantPrice(poster, paper, size) <= 0) {
          const first = SIZES.find((s) => getVariantPrice(poster, paper, s.key) > 0);
          if (first) size = first.key;
        }
        rerenderPickers();
        updatePriceAndPreview();
      });
    });

    document.querySelectorAll('input[name="size"]').forEach((el) => {
      el.addEventListener("change", () => {
        size = el.value;
        updatePriceAndPreview();
      });
    });

    document.querySelectorAll('input[name="mode"]').forEach((el) => {
      el.addEventListener("change", () => {
        mode = el.value;
        updatePriceAndPreview();
      });
    });
  }

  rerenderPickers();
  updatePriceAndPreview();

  $("buyBtn").addEventListener("click", async () => {
    const payload = { posterId: poster.id, size, paper, mode, quantity: 1 };
    const r = await fetch("/api/create-poster-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json();
    if (!r.ok) {
      alert(j?.error || "Checkout failed");
      return;
    }
    location.href = j.url;
  });
}

main().catch((e) => {
  console.error(e);
  const page = document.getElementById("page");
  if (page) page.innerHTML = `<p class="muted">Error loading poster.</p>`;
});
