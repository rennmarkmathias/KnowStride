// public/app.js
(async () => {
  const $ = (id) => document.getElementById(id);

  const authBox = $("authBox");
  const appBox = $("appBox");
  const authStatus = $("authStatus");
  const authError = $("authError");
  const clerkMount = $("clerkMount");
  const logoutBtn = $("logoutBtn");
  const appContent = $("appContent");

  if (!clerkMount) {
    // This is the error you’re seeing right now.
    if (authError) authError.textContent = "Missing #clerkMount in app.html";
    return;
  }

  const qs = new URLSearchParams(window.location.search);
  const plan = qs.get("plan"); // e.g. monthly, yearly, etc.

  function setStatus(msg) {
    if (authStatus) authStatus.textContent = msg || "";
  }
  function setError(msg) {
    if (authError) authError.textContent = msg || "";
  }

  function showAuth() {
    authBox.style.display = "";
    appBox.style.display = "none";
    logoutBtn.style.display = "none";
  }

  function showApp() {
    authBox.style.display = "none";
    appBox.style.display = "";
    logoutBtn.style.display = "";
  }

  async function getConfig() {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok) throw new Error(`Config failed: ${res.status}`);
    return res.json();
  }

  async function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.crossOrigin = "anonymous";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  async function loadClerkBrowser() {
    // We try your Clerk domain first, then fall back to jsDelivr.
    const candidates = [
      // Your Clerk frontend domain (as you configured in Clerk dashboard)
      "https://clerk.knowstride.com/npm/@clerk/clerk-js@latest/dist/clerk.browser.js",
      // Fallback CDN
      "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js",
    ];

    let lastErr;
    for (const src of candidates) {
      try {
        await loadScript(src);
        if (window.Clerk) return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Clerk failed to load");
  }

  async function getBearerToken() {
    // Clerk sets Clerk.session when signed in
    if (!window.Clerk || !window.Clerk.session) return null;
    try {
      return await window.Clerk.session.getToken();
    } catch {
      return null;
    }
  }

  async function apiFetch(path, options = {}) {
    const token = await getBearerToken();
    const headers = new Headers(options.headers || {});
    if (token) headers.set("Authorization", `Bearer ${token}`);
    headers.set("Content-Type", "application/json");
    return fetch(path, { ...options, headers, cache: "no-store" });
  }

  async function apiGet(path) {
    const res = await apiFetch(path, { method: "GET" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `GET ${path} failed (${res.status})`);
    return data;
  }

  async function apiPost(path, bodyObj) {
    const res = await apiFetch(path, {
      method: "POST",
      body: JSON.stringify(bodyObj || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `POST ${path} failed (${res.status})`);
    return data;
  }

  async function renderApp() {
    // Example: show something simple + your library endpoint
    appContent.innerHTML = "";
    const me = await apiGet("/api/me");

    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = me?.email ? `Signed in as ${me.email}` : "Signed in";
    appContent.appendChild(p);

    // Load library list (if you have it)
    try {
      const lib = await apiGet("/api/library");
      const pre = document.createElement("pre");
      pre.style.whiteSpace = "pre-wrap";
      pre.textContent = JSON.stringify(lib, null, 2);
      appContent.appendChild(pre);
    } catch (e) {
      const err = document.createElement("p");
      err.style.color = "#b00020";
      err.textContent = `Library error: ${e.message}`;
      appContent.appendChild(err);
    }
  }

  async function handlePlanPurchase(selectedPlan) {
    if (!selectedPlan) return;
    setStatus("Starting checkout…");
    setError("");

    const me = await apiGet("/api/me");
    if (!me?.signedIn) {
      setStatus("Please sign in first.");
      return;
    }

    const out = await apiPost("/api/create-checkout-session", { plan: selectedPlan });
    if (!out?.url) throw new Error("No checkout URL returned from server.");
    window.location.href = out.url;
  }

  try {
    showAuth();
    setStatus("Loading config…");
    const cfg = await getConfig();

    if (!cfg?.clerkPublishableKey) {
      throw new Error("Missing clerkPublishableKey from /api/config");
    }

    setStatus("Loading Clerk…");
    await loadClerkBrowser();

    setStatus("Initializing…");
    await window.Clerk.load({
      publishableKey: cfg.clerkPublishableKey,
    });

    // Always mount SignIn UI on this page.
    // IMPORTANT: Force redirect back to this /app URL after sign-in/up.
    const here = window.location.href;

    // If you want sign-up too, Clerk SignIn includes link to sign-up by default.
    window.Clerk.mountSignIn(clerkMount, {
      redirectUrl: here,
      afterSignInUrl: here,
      afterSignUpUrl: here,
    });

    // React to auth state changes
    const updateUI = async () => {
      setError("");

      if (window.Clerk.user && window.Clerk.session) {
        showApp();
        setStatus("");
        await renderApp();

        // Auto-checkout if plan=... is present
        if (plan) {
          await handlePlanPurchase(plan);
        }
      } else {
        showAuth();
        setStatus("Not signed in.");
      }
    };

    // Initial paint
    await updateUI();

    // Listener for sign-in/out changes
    window.Clerk.addListener(() => {
      updateUI().catch((e) => setError(e.message));
    });

    logoutBtn.addEventListener("click", async () => {
      try {
        await window.Clerk.signOut();
      } finally {
        window.location.href = "/";
      }
    });
  } catch (e) {
    showAuth();
    setStatus("");
    setError(e?.message || String(e));
  }
})();
