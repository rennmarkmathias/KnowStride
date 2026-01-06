(() => {
  const $ = (sel) => document.querySelector(sel);

  const logoutBtn = $("#logoutBtn");
  const authBox = $("#authBox");
  const authStatus = $("#authStatus");
  const authError = $("#authError");
  const clerkMount = $("#clerk-components");

  const appBox = $("#appBox");
  const appTitle = $("#appTitle");
  const appContent = $("#appContent");

  function getParam(name) {
    const u = new URL(window.location.href);
    return u.searchParams.get(name);
  }

  function buildReturnUrl() {
    // Behåll plan-parametern om den finns, så att man hamnar tillbaka rätt efter login.
    const u = new URL(window.location.href);
    const plan = u.searchParams.get("plan");
    const canceled = u.searchParams.get("canceled");
    const success = u.searchParams.get("success");

    // “Rensa” success/canceled så man inte fastnar i loopar
    u.searchParams.delete("success");
    u.searchParams.delete("canceled");

    // Men behåll plan
    if (plan) u.searchParams.set("plan", plan);

    // Om någon manuellt hade success/canceled, ta inte med dem
    if (canceled) u.searchParams.delete("canceled");
    if (success) u.searchParams.delete("success");

    return u.toString();
  }

  async function fetchJSON(url, opts = {}) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`${url} failed (${res.status}): ${txt || res.statusText}`);
    }
    return res.json();
  }

  async function ensureClerkScript() {
    if (window.Clerk) return;

    // Ladda Clerk från jsDelivr (inte js.clerk.com)
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.async = true;
      s.crossOrigin = "anonymous";
      s.src = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5/dist/clerk.browser.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load Clerk script from jsDelivr"));
      document.head.appendChild(s);
    });

    if (!window.Clerk) throw new Error("Clerk script loaded, but window.Clerk is missing.");
  }

  async function getToken() {
    if (!window.Clerk?.session) return null;
    return await window.Clerk.session.getToken();
  }

  async function api(url, opts = {}) {
    const token = await getToken();
    const headers = new Headers(opts.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...opts, headers });
  }

  function setAuthUI({ signedIn, message = "" }) {
    authStatus.textContent = message || (signedIn ? "Signed in." : "Not logged in.");
    logoutBtn.style.display = signedIn ? "" : "none";
    appBox.style.display = signedIn ? "" : "none";
  }

  async function renderLibrary() {
    appTitle.textContent = "Library";
    appContent.innerHTML = `<p class="muted">Loading library…</p>`;

    const res = await api("/api/library");
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      appContent.innerHTML = `<p style="color:#b00020;">Failed to load library: ${res.status} ${txt}</p>`;
      return;
    }

    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];

    if (!items.length) {
      appContent.innerHTML = `<p class="muted">No items yet.</p>`;
      return;
    }

    appContent.innerHTML = `
      <ul style="padding-left:18px;">
        ${items.map(it => `<li>${escapeHtml(it.title || "Untitled")}</li>`).join("")}
      </ul>
    `;
  }

  async function renderCheckout(plan) {
    appTitle.textContent = "Checkout";
    appContent.innerHTML = `<p class="muted">Starting checkout…</p>`;

    const res = await api("/api/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan })
    });

    const txt = await res.text().catch(() => "");
    if (!res.ok) {
      appContent.innerHTML = `<p style="color:#b00020;">Checkout failed: ${res.status} ${txt}</p>`;
      return;
    }

    let data;
    try { data = JSON.parse(txt); } catch { data = {}; }

    if (data?.url) {
      window.location.href = data.url;
      return;
    }

    appContent.innerHTML = `<p style="color:#b00020;">Checkout failed: missing URL.</p>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function mountSignIn(returnUrl) {
    clerkMount.innerHTML = "";
    authError.textContent = "";

    // Mounta Clerk sign-in i din egen sida
    window.Clerk.mountSignIn(clerkMount, {
      appearance: { elements: { footer: { display: "none" } } },
      afterSignInUrl: returnUrl,
      afterSignUpUrl: returnUrl
    });
  }

  async function main() {
    try {
      setAuthUI({ signedIn: false, message: "Loading sign-in…" });

      // 1) Hämta publishable key från ditt API
      const cfg = await fetchJSON("/api/config");
      const publishableKey = cfg?.clerkPublishableKey;
      if (!publishableKey) throw new Error("Missing clerkPublishableKey from /api/config");

      // 2) Ladda Clerk-script + init
      await ensureClerkScript();

      // Viktigt: vänta på Clerk.load()
      await window.Clerk.load({ publishableKey });

      // 3) Logout-knapp
      logoutBtn.addEventListener("click", async () => {
        try {
          await window.Clerk.signOut();
          window.location.href = "/app";
        } catch (e) {
          console.error(e);
        }
      });

      // 4) Lyssna på auth-status (så vi inte fastnar i “user null”)
      const rerender = async () => {
        const signedIn = !!window.Clerk.user;
        setAuthUI({ signedIn, message: signedIn ? "Signed in." : "Not logged in." });

        const plan = getParam("plan");

        if (!signedIn) {
          appBox.style.display = "none";
          const returnUrl = buildReturnUrl();
          await mountSignIn(returnUrl);
          return;
        }

        // Inloggad => visa app
        authBox.style.display = "none";
        appBox.style.display = "";

        if (plan) {
          await renderCheckout(plan);
        } else {
          await renderLibrary();
        }
      };

      // Kör direkt + vid förändringar
      await rerender();
      window.Clerk.addListener(() => rerender());

    } catch (err) {
      console.error(err);
      authError.textContent = String(err?.message || err);
      authStatus.textContent = "Failed to initialize login.";
    }
  }

  main();
})();
