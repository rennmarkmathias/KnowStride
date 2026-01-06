(() => {
  const $ = (id) => document.getElementById(id);

  const authBox = $("authBox");
  const appBox = $("appBox");
  const authStatus = $("authStatus");
  const authError = $("authError");
  const clerkMount = $("clerkMount");
  const logoutBtn = $("logoutBtn");
  const appTitle = $("appTitle");
  const appContent = $("appContent");

  function setStatus(msg) {
    if (authStatus) authStatus.textContent = msg || "";
  }
  function setError(msg) {
    if (authError) authError.textContent = msg || "";
  }

  function parseQuery() {
    const q = new URLSearchParams(window.location.search);
    return Object.fromEntries(q.entries());
  }

  async function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = [...document.scripts].find((s) => s.src === src);
      if (existing) return resolve();

      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load script: " + src));
      document.head.appendChild(s);
    });
  }

  async function apiFetch(path, { method = "GET", body, token } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "include",
    });

    const txt = await res.text();
    let data;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }

    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  async function getConfig() {
    return apiFetch("/api/config");
  }

  function maskKey(k) {
    if (!k || typeof k !== "string") return String(k);
    if (k.length <= 10) return k;
    return k.slice(0, 6) + "…" + k.slice(-4);
  }

  async function initClerk(cfg) {
    if (!clerkMount) {
      throw new Error("Missing #clerkMount in app.html");
    }

    const pk = cfg?.clerkPublishableKey;

    // Stop early with a friendly message (prevents Clerk throwing cryptic errors)
    if (!pk || typeof pk !== "string") {
      throw new Error(
        "Missing CLERK publishable key. Open /api/config and verify clerkPublishableKey is present."
      );
    }
    if (!pk.startsWith("pk_")) {
      throw new Error(
        `CLERK publishable key looks wrong: ${maskKey(pk)} (should start with "pk_").`
      );
    }

    // Load Clerk browser SDK
    await loadScript("https://js.clerk.com/v4/clerk.browser.js");

    if (!window.Clerk) {
      throw new Error("Clerk script loaded, but window.Clerk is missing.");
    }

    // Initialize Clerk
    await window.Clerk.load({
      publishableKey: pk,
    });

    return window.Clerk;
  }

  function showAuthedUI(user) {
    authBox.style.display = "none";
    appBox.style.display = "block";
    logoutBtn.style.display = "inline-block";

    const email =
      user?.primaryEmailAddress?.emailAddress ||
      user?.emailAddresses?.[0]?.emailAddress ||
      "(no email)";

    appTitle.textContent = "Library";
    appContent.innerHTML = `
      <p class="muted">Signed in as <strong>${escapeHtml(email)}</strong></p>
      <p style="margin-top:10px;">
        If you came here to buy a plan, you'll be redirected automatically.
      </p>
    `;
  }

  function showAuthUI() {
    authBox.style.display = "block";
    appBox.style.display = "none";
    logoutBtn.style.display = "none";
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[c]));
  }

  async function maybeStartCheckout(clerk, plan) {
    if (!plan) return;

    // Only allow known plans
    const allowed = new Set(["monthly", "yearly", "3y", "6y", "9y"]);
    if (!allowed.has(plan)) return;

    setStatus("Starting checkout…");

    // Optional: attach who is buying (works even if backend doesn't require it)
    const token = await clerk.session?.getToken?.();

    const data = await apiFetch("/api/create-checkout-session", {
      method: "POST",
      body: { plan },
      token,
    });

    if (!data?.url) throw new Error("Checkout session created, but no URL returned.");
    window.location.href = data.url;
  }

  async function mountAuth(clerk) {
    const q = parseQuery();
    const mode = q.mode; // "signup" to force sign-up view

    // Always clear mount first
    clerkMount.innerHTML = "";

    const common = {
      // Keep user on your app route
      afterSignInUrl: "/app",
      afterSignUpUrl: "/app",
      signInUrl: "/app",
      signUpUrl: "/app?mode=signup",
    };

    if (mode === "signup") {
      setStatus("Sign up…");
      clerk.mountSignUp(clerkMount, common);
    } else {
      setStatus("Sign in…");
      clerk.mountSignIn(clerkMount, common);
    }
  }

  async function main() {
    showAuthUI();
    setError("");
    setStatus("Loading…");

    // Helpful click handler
    logoutBtn?.addEventListener("click", async () => {
      try {
        if (window.Clerk) await window.Clerk.signOut();
        window.location.href = "/app";
      } catch {
        window.location.href = "/app";
      }
    });

    const q = parseQuery();
    const plan = q.plan || null;

    const cfg = await getConfig();

    // Init Clerk
    const clerk = await initClerk(cfg);

    // If already signed in
    if (clerk.user) {
      showAuthedUI(clerk.user);
      await maybeStartCheckout(clerk, plan);
      return;
    }

    // Not signed in → mount auth UI and wait for sign-in
    await mountAuth(clerk);
    showAuthUI();

    // When a user signs in, Clerk updates state; poll briefly (simple & robust for static sites)
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (clerk.user) {
        clearInterval(timer);
        showAuthedUI(clerk.user);
        try {
          await maybeStartCheckout(clerk, plan);
        } catch (e) {
          setError(String(e?.message || e));
        }
      }
      // stop after 2 minutes
      if (Date.now() - startedAt > 120000) clearInterval(timer);
    }, 500);
  }

  main().catch((err) => {
    console.error(err);
    setStatus("");
    setError(err?.message ? err.message : String(err) || "Clerk failed to load");
  });
})();
