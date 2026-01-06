function planLabel(plan) {
  const map = {
    monthly: "Monthly ($2.99)",
    yearly: "Yearly ($14.99)",
    "3y": "3 Years ($24.99)",
    "6y": "6 Years ($39.99)",
    "9y": "9 Years ($49.99)",
  };
  return map[plan] || plan;
}

function getParams() {
  const u = new URL(window.location.href);
  return {
    plan: u.searchParams.get("plan"),
    success: u.searchParams.get("success") === "1",
  };
}

function $(id) {
  return document.getElementById(id);
}

function show(el, yes) {
  if (!el) return;
  el.style.display = yes ? "" : "none";
}

function setText(el, txt) {
  if (!el) return;
  el.textContent = txt;
}

async function apiGet(path) {
  const r = await fetch(path, { credentials: "include" });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body || {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error || `${path} ${r.status}`);
  return data;
}

async function loadClerk() {
  const cfg = await fetch("/api/config").then((r) => r.json());
  const pk = cfg?.clerkPublishableKey;

  if (!pk || typeof pk !== "string") {
    throw new Error("Missing/invalid CLERK_PUBLISHABLE_KEY on server.");
  }

  // Try multiple CDNs in case one is blocked by DNS/ISP.
  const sources = [
    // If you have Clerk proxy/domain enabled, this often works:
    "https://clerk.knowstride.com/npm/@clerk/clerk-js@4/dist/clerk.browser.js",
    "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@4/dist/clerk.browser.js",
    "https://unpkg.com/@clerk/clerk-js@4/dist/clerk.browser.js",
    "https://js.clerk.com/v4/clerk.browser.js",
  ];

  let lastErr = null;

  for (const src of sources) {
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.async = true;
        s.src = src;
        s.setAttribute("data-clerk-publishable-key", pk.trim());
        s.onload = resolve;
        s.onerror = () => reject(new Error("Failed to load: " + src));
        document.head.appendChild(s);
      });

      if (!window.Clerk) {
        throw new Error("Clerk script loaded but window.Clerk is missing.");
      }

      // Some builds accept a config object, others don't; handle both.
      try {
        await window.Clerk.load({ publishableKey: pk.trim() });
      } catch {
        await window.Clerk.load();
      }

      return window.Clerk;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Failed to load Clerk.");
}

async function mountSignIn() {
  const authError = $("authError");
  const authStatus = $("authStatus");
  const mount = $("clerkMount");

  try {
    setText(authStatus, "Loading sign-in…");
    const Clerk = await loadClerk();

    // Render sign-in UI
    setText(authStatus, "");
    show(authError, false);

    if (!mount) throw new Error("Missing #clerkMount in app.html");

    // Clean mount (in case of hot reload / retries)
    mount.innerHTML = "";

    // Mount Clerk sign-in
    Clerk.mountSignIn(mount, {
      // You can set routing if needed:
      // redirectUrl: "/app",
    });
  } catch (e) {
    show(authError, true);
    authError.textContent = String(e?.message || e);

    // Extra friendly status text
    setText(
      authStatus,
      "Inloggningen kunde inte laddas (Clerk script). Prova att ladda om sidan. " +
        "Om felet är “publishableKey is invalid” är CLERK_PUBLISHABLE_KEY fel i Cloudflare."
    );
  }
}

async function loadLibrary() {
  const authBox = $("authBox");
  const libraryBox = $("libraryBox");
  const logoutBtn = $("logoutBtn");
  const libraryMeta = $("libraryMeta");
  const libraryList = $("libraryList");
  const planBox = $("planBox");

  try {
    const me = await apiGet("/api/me");
    if (!me?.signedIn) {
      show(libraryBox, false);
      show(authBox, true);
      if (logoutBtn) logoutBtn.style.visibility = "hidden";
      await mountSignIn();
      return;
    }

    // Signed in
    show(authBox, false);
    show(libraryBox, true);
    if (logoutBtn) logoutBtn.style.visibility = "visible";

    // Meta
    setText(libraryMeta, me?.email ? `Signed in as ${me.email}` : "Signed in");

    // Library content
    const lib = await apiGet("/api/library");
    const items = Array.isArray(lib?.items) ? lib.items : [];

    // Plan UI
    if (planBox) {
      planBox.innerHTML = "";
      if (!me?.hasAccess) {
        planBox.innerHTML = `
          <div class="muted" style="margin-top:6px;">
            Choose a plan to access the library.
          </div>
          <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">
            <a class="btn" href="/app?plan=monthly">Monthly</a>
            <a class="btn" href="/app?plan=yearly">Yearly</a>
            <a class="btn" href="/app?plan=3y">3 Years</a>
            <a class="btn" href="/app?plan=6y">6 Years</a>
            <a class="btn" href="/app?plan=9y">9 Years</a>
          </div>
        `;
      } else {
        planBox.innerHTML = `<div class="muted">Access: active</div>`;
      }
    }

    // Render list
    if (libraryList) {
      libraryList.innerHTML = items
        .map(
          (it) => `
        <div class="row" style="padding:10px 0; border-top:1px solid rgba(0,0,0,0.06);">
          <div>
            <div style="font-weight:600;">${it.title || "Untitled"}</div>
            <div class="muted">${it.subtitle || ""}</div>
          </div>
          ${it.url ? `<a class="btn" href="${it.url}">Open</a>` : ""}
        </div>
      `
        )
        .join("");

      if (!items.length) {
        libraryList.innerHTML = `<div class="muted">No items yet.</div>`;
      }
    }
  } catch (e) {
    // Fallback to auth UI on any error
    show($("libraryBox"), false);
    show($("authBox"), true);
    await mountSignIn();
  }
}

async function handlePlanPurchase() {
  const { plan, success } = getParams();
  if (!plan) return;

  // If Stripe redirected back successfully, refresh state
  if (success) {
    // remove query to keep clean
    const u = new URL(location.href);
    u.searchParams.delete("success");
    u.searchParams.delete("plan");
    history.replaceState({}, "", u.toString());
    return;
  }

  // Start checkout
  try {
    const res = await apiPost("/api/create-checkout-session", { plan });
    if (res?.url) {
      window.location.href = res.url;
    }
  } catch (e) {
    // show error in auth box (simple)
    const authError = $("authError");
    show(authError, true);
    authError.textContent = String(e?.message || e);
  }
}

async function wireLogout() {
  const btn = $("logoutBtn");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    try {
      await apiPost("/api/logout", {});
    } catch {}
    location.href = "/app";
  });
}

(async function main() {
  await wireLogout();
  await handlePlanPurchase();
  await loadLibrary();
})();
