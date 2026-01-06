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

function getParams() {
  const u = new URL(window.location.href);
  return {
    plan: u.searchParams.get("plan"),
    success: u.searchParams.get("success") === "1",
  };
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

  // Flera källor (pga ISP/DNS-strul som du såg tidigare)
  const sources = [
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

      if (!window.Clerk) throw new Error("Clerk script loaded but window.Clerk is missing.");

      // vissa builds tar publishableKey i load(), andra inte – kör robust
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

function renderPlanButtons(me) {
  const planBox = $("planBox");
  if (!planBox) return;

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

function renderLibrary(items) {
  const libraryList = $("libraryList");
  if (!libraryList) return;

  const safe = Array.isArray(items) ? items : [];
  libraryList.innerHTML = safe
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

  if (!safe.length) {
    libraryList.innerHTML = `<div class="muted">No items yet.</div>`;
  }
}

async function mountSignIn() {
  const authError = $("authError");
  const authStatus = $("authStatus");
  const mount = $("clerkMount");

  try {
    setText(authStatus, "Loading sign-in…");
    show(authError, false);

    const Clerk = await loadClerk();

    if (!mount) throw new Error("Missing #clerkMount in app.html");
    mount.innerHTML = "";

    // SUPERviktigt:
    // Säg explicit vart Clerk ska skicka tillbaka efter OAuth/sign-in,
    // annars kan du hamna på / (eller Account Portal) och “studsa”.
    Clerk.mountSignIn(mount, {
      afterSignInUrl: "/app",
      afterSignUpUrl: "/app",
      redirectUrl: "/app",
    });

    // När användaren blir inloggad: ladda appen direkt
    Clerk.addListener(async (e) => {
      if (e?.user) {
        await loadLibrary(); // refresh UI + plan flow
      }
    });

    setText(authStatus, "");
  } catch (e) {
    show(authError, true);
    authError.textContent = String(e?.message || e);

    setText(
      authStatus,
      "Inloggningen kunde inte laddas (Clerk script). Prova att ladda om sidan."
    );
  }
}

async function startCheckout(plan) {
  const authError = $("authError");
  try {
    const res = await apiPost("/api/create-checkout-session", { plan });
    if (res?.url) window.location.href = res.url;
    else throw new Error("No checkout URL returned.");
  } catch (e) {
    show(authError, true);
    authError.textContent = String(e?.message || e);
  }
}

async function handlePlanPurchase() {
  const { plan, success } = getParams();
  if (!plan) return;

  // Stripe returnerar ofta success=1 när du kommer tillbaka
  if (success) {
    const u = new URL(location.href);
    u.searchParams.delete("success");
    u.searchParams.delete("plan");
    history.replaceState({}, "", u.toString());
    return;
  }

  // Om användaren inte är inloggad: spara plan och visa sign-in.
  // När login blir klart plockar vi upp pending-plan och fortsätter checkout.
  try {
    const me = await apiGet("/api/me");
    if (!me?.signedIn) {
      sessionStorage.setItem("pendingPlan", plan);
      // rensa urlen lite så vi inte loopar
      const u = new URL(location.href);
      u.searchParams.delete("plan");
      history.replaceState({}, "", u.toString());
      return;
    }

    await startCheckout(plan);
  } catch {
    sessionStorage.setItem("pendingPlan", plan);
  }
}

async function maybeContinuePendingPlan() {
  const pending = sessionStorage.getItem("pendingPlan");
  if (!pending) return;

  try {
    const me = await apiGet("/api/me");
    if (me?.signedIn) {
      sessionStorage.removeItem("pendingPlan");
      await startCheckout(pending);
    }
  } catch {
    // ignore
  }
}

async function loadLibrary() {
  const authBox = $("authBox");
  const libraryBox = $("libraryBox");
  const logoutBtn = $("logoutBtn");
  const libraryMeta = $("libraryMeta");

  try {
    const me = await apiGet("/api/me");

    if (!me?.signedIn) {
      show(libraryBox, false);
      show(authBox, true);
      if (logoutBtn) logoutBtn.style.visibility = "hidden";
      await mountSignIn();
      return;
    }

    show(authBox, false);
    show(libraryBox, true);
    if (logoutBtn) logoutBtn.style.visibility = "visible";

    setText(libraryMeta, me?.email ? `Signed in as ${me.email}` : "Signed in");

    renderPlanButtons(me);

    const lib = await apiGet("/api/library");
    renderLibrary(lib?.items);

    // Om user blev inloggad pga OAuth nu: fortsätt ev. checkout
    await maybeContinuePendingPlan();
  } catch (e) {
    // fallback: visa auth
    show($("libraryBox"), false);
    show($("authBox"), true);
    await mountSignIn();
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
