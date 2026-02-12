/*
  Minimal poster storefront logic (no build step).
  - Reads /data/posters.json
  - Renders cards into #posterGrid
  - Simple category filter + sort
*/

const $ = (id) => document.getElementById(id);

function formatFromPrice(poster) {
  const all = [];
  for (const paper of Object.keys(poster.prices || {})) {
    const sizes = poster.prices[paper] || {};
    for (const k of Object.keys(sizes)) {
      const v = Number(sizes[k]);
      if (Number.isFinite(v)) all.push(v);
    }
  }
  if (!all.length) return "";
  const min = Math.min(...all);
  return `From $${min}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cardHtml(p) {
  const title = escapeHtml(p.title);
  const cat = escapeHtml(p.category || "");
  const tag = escapeHtml(p.tag || "");
  const from = escapeHtml(formatFromPrice(p));
  const href = `/p.html?slug=${encodeURIComponent(p.slug)}`;
  return `
    <a class="poster-card" href="${href}">
      <div class="poster-img">
        <img src="${p.previewUrl}" alt="${title}" loading="lazy" />
      </div>
      <div class="poster-meta">
        <div class="poster-title">${title}</div>
        <div class="poster-sub">
          <span class="badge">${cat}</span>
          ${tag ? `<span class="muted">${tag}</span>` : ""}
        </div>
        <div class="poster-price">${from}</div>
        <div class="poster-ship">Free shipping</div>
      </div>
    </a>
  `.trim();
}

function uniqueCategories(posters) {
  const set = new Set();
  posters.forEach((p) => p.category && set.add(p.category));
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function applySort(posters, sortKey) {
  const arr = [...posters];
  if (sortKey === "title") {
    arr.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  } else {
    // "new": sort by year (desc), then title
    arr.sort((a, b) => (Number(b.year || 0) - Number(a.year || 0)) || String(a.title).localeCompare(String(b.title)));
  }
  return arr;
}

async function main() {
  // Footer year
  const y = document.getElementById("year");
  if (y) y.textContent = String(new Date().getFullYear());

  const grid = $("posterGrid");
  const filter = $("filterCategory");
  const sort = $("sort");

  if (!grid) return;

  let posters = [];
  try {
    const res = await fetch("/data/posters.json", { cache: "no-store" });
    const data = await res.json();
    posters = Array.isArray(data.posters) ? data.posters : [];
  } catch {
    posters = [];
  }

  // Populate categories
  if (filter) {
    const cats = uniqueCategories(posters);
    cats.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      filter.appendChild(opt);
    });
  }

  const render = () => {
    const cat = filter?.value || "";
    const sortKey = sort?.value || "new";
    let list = posters;
    if (cat) list = list.filter((p) => p.category === cat);
    list = applySort(list, sortKey);

    if (!list.length) {
      grid.innerHTML = `<div class="empty">No posters found.</div>`;
      return;
    }

    grid.innerHTML = list.map(cardHtml).join("");
  };

  filter?.addEventListener("change", render);
  sort?.addEventListener("change", render);
  render();
}

main();
