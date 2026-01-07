(() => {
  const $ = (id) => document.getElementById(id);

  const authBox = $("authBox");
  const appBox = $("appBox");
  const authStatus = $("authStatus");
  const authError = $("authError");
  const clerkMount = $("clerk-components");
  const logoutBtn = $("logoutBtn");
  const appContent = $("appContent");

  // Keep it simple: one canonical app URL
  const APP_URL = "/app.html";

  // If you already have a hardcoded pk_ that works, keep it here:
  // (We still try /api/config first, but will fall back to this.)
  const FALLBACK_PUBLISHABLE_KEY = "pk_live_REPLACE_ME_IF_NEEDED";

  function showError(msg) {
    authError.textContent = msg || "";
  }

  function setStatus(msg) {
    authStatus.textContent = msg || "";
  }

  function showApp() {
    authBox.style.display = "none";
    appBox.style.display = "block";
    logoutBtn.style.display = "inline-block";
  }

  function showAuth() {
    authBox.style.display = "block";
    appBox.style.display = "none";
    logoutBtn.style.display = "none";
  }

  function getPlanFromUrl() {
    const plan = new URLSearchParams(location.search).get("plan");
    // Allowed plans (match backend)
    const allowed = new Set(["monthly", "yearly", "3y", "6y", "9y"]);
    return allowed.has(plan) ? plan : null;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitForClerkGlobal(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.Clerk && typeof window.Clerk.load === "function") return;
      await sleep(50);
    }
    throw new Error("Clerk script loaded but window.Clerk is still missing.");
  }

  async function fetchPublishableKey() {
    // Prefer /api/config if available
    try {
      const res = await fetch("/api/config", {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        const data = await res.json();
        const pk = data?.clerkPublishableKey;
        if (typeof pk === "string" && pk.startsWith("pk_")) return pk;
      }
    } catch (_) {
      // ignore and fall back
    }

    if (
      typeof FALLBACK_PUBLISHABLE_KEY === "string" &&
      FALLBACK_PUBLISHABLE_KEY.startsWith("pk_") &&
      !FALLBACK_PUBLISHABLE_KEY.includes("REPLACE_ME")
    ) {
      return FALLBACK_PUBLISHABLE_KEY;
    }

    throw new Error(
      "Missing Clerk publishable key. Fix /api/config or set FALLBACK_PUBLISHABLE_KEY in app.js."
    );
  }

  async function getAuthToken() {
    // Requires user to be signed in
    const session = window.Clerk?.session;
    if (!session || typeof session.getToken !== "function") return null;
    return await session.getToken();
  }

  async function apiFetchJson(url, { method = "GET", body } = {}) {
    const token = await getAuthToken();
    if (!token) {
      const err = new Error("Not logged in.");
      err.status = 401;
      throw err;
    }

    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      // non-json
    }

    if (!res.ok) {
      const msg =
        data?.error ||
        data?.message ||
        `Request failed: ${res.status} ${res.statusText}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  function renderPaywall({ planFromUrl = null } = {}) {
    showApp();
    appContent.innerHTML = `
      <p class="muted">✅ You are signed in, but you don’t have an active subscription yet.</p>

      <div style="margin-top:14px;">
        <h3 style="margin:0 0 8px 0;">Choose a plan</h3>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn" data-plan="monthly">Monthly <span class="price">$2.99</span></button>
          <button class="btn" data-plan="yearly">Yearly <span class="price">$14.99</span></button>
          <button class="btn" data-plan="3y">3 years <span class="price">$24.99</span></button>
          <button class="btn" data-plan="6y">6 years <span class="price">$39.99</span></button>
          <button class="btn" data-plan="9y">9 years <span class="price">$49.99</span></button>
        </div>
        <p class="muted" style="margin-top:10px;">
          After purchase, refresh will unlock the library automatically.
        </p>
        ${
          planFromUrl
            ? `<p class="muted" style="margin-top:10px;">Plan from URL detected: <strong>${planFromUrl}</strong> — starting checkout…</p>`
            : ""
        }
      </div>
    `;

    // simple button styling if you don't have .btn
    const style = document.createElement("style");
    style.textContent = `
      .btn { padding:10px 14px; border-radius:12px; border:1px solid #ddd; background:#fff; cursor:pointer; }
      .btn .price { opacity:0.75; margin-left:6px; font-weight:500; }
      .btn:hover { filter: brightness(0.98); }
    `;
    document.head.appendChild(style);

    appContent.querySelectorAll("button[data-plan]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const plan = btn.getAttribute("data-plan");
        await startCheckout(plan);
      });
    });
  }

  function renderLibrary(items, meta) {
    showApp();

    const until = meta?.accessUntil ? new Date(meta.accessUntil) : null;

    const list = (items || [])
      .map(
        (it) => `
        <article class="card" style="margin-top:12px;">
          <h3 style="margin:0 0 6px 0;">${escapeHtml(it.title || "")}</h3>
          <p class="muted" style="margin:0 0 10px 0;">${escapeHtml(
            it.summary || ""
          )}</p>
          ${
            it.url
              ? `<a href="${escapeAttr(
                  it.url
                )}" target="_blank" rel="noopener noreferrer">Open</a>`
              : ""
          }
        </article>
      `
      )
      .join("");

    appContent.innerHTML = `
      <p class="muted">Logged in as: <strong>${escapeHtml(
        window.Clerk?.user?.primaryEmailAddress?.emailAddress ||
          window.Clerk?.user?.username ||
          "Unknown"
      )}</strong></p>
      <p style="margin-top:8px;">
        ✅ Subscription active${until ? ` (until ${until.toLocaleString()})` : ""}.
      </p>

      <div style="margin-top:14px;">
        <h3 style="margin:0;">This week’s library</h3>
        ${list || `<p class="muted" style="margin-top:10px;">No items yet.</p>`}
      </div>
    `;
  }

  async function startCheckout(plan) {
    try {
      setStatus("Starting Stripe checkout…");
      showError("");

      const successUrl = `${location.origin}/app?success=1`;
      const cancelUrl = `${location.origin}/app?canceled=1`;

      const data = await apiFetchJson("/api/create-checkout-session", {
        method: "POST",
        body: { plan, successUrl, cancelUrl },
      });

      if (!data?.url) throw new Error("Stripe session URL missing.");
      location.href = data.url;
    } catch (err) {
      console.error(err);
      setStatus("");
      showError(err?.message || String(err));
    }
  }

  async function loadLibraryOrPaywall() {
    // Called after Clerk is loaded and user is signed in
    const planFromUrl = getPlanFromUrl();

    // If user came back from Stripe success, we may need to wait for webhook -> D1
    const params = new URLSearchParams(location.search);
    const isSuccess = params.get("success") === "1";
    const sessionId = params.get("session_id");

    if (isSuccess) {
      setStatus("Payment received. Activating your access…");

      // Best-effort confirmation to unlock immediately even if the webhook is delayed/missed.
      if (sessionId) {
        try {
          await apiFetchJson(`/api/confirm-checkout?session_id=${encodeURIComponent(sessionId)}`);
        } catch (err) {
          // Non-fatal; we'll still poll /api/library below.
          console.warn("confirm-checkout failed", err);
        }
      }
    } else {
      setStatus("Loading your library…");
    }

    // Poll a few times if needed (webhook may lag)
    const maxTries = isSuccess ? 10 : 1;
    for (let i = 0; i < maxTries; i++) {
      try {
        const data = await apiFetchJson("/api/library");
        if (data?.accessGranted) {
          setStatus("");
          renderLibrary(data.items, data);
          return;
        }
        // Not granted
        if (isSuccess) await sleep(1200);
      } catch (err) {
        // If not logged in on backend -> show auth again
        if (err?.status === 401) throw err;
        console.error(err);
        if (isSuccess) await sleep(1200);
      }
    }

    setStatus("");
    renderPaywall({ planFromUrl });

    // If plan in URL, auto-start checkout (only once, after UI is shown)
    if (planFromUrl) {
      await sleep(200);
      await startCheckout(planFromUrl);
    }
  }

  async function mountSignIn() {
    clerkMount.innerHTML = "";
    await window.Clerk.mountSignIn(clerkMount, {
      signUpUrl: APP_URL,
      // Newer Clerk recommends these instead of deprecated afterSignInUrl/redirectUrl
      fallbackRedirectUrl: APP_URL,
      forceRedirectUrl: APP_URL,
    });
  }

  async function mountSignUp() {
    clerkMount.innerHTML = "";
    await window.Clerk.mountSignUp(clerkMount, {
      signInUrl: APP_URL,
      fallbackRedirectUrl: APP_URL,
      forceRedirectUrl: APP_URL,
    });
  }

  async function boot() {
    try {
      showError("");
      setStatus("Loading authentication…");

      await waitForClerkGlobal();
      const publishableKey = await fetchPublishableKey();
      await window.Clerk.load({ publishableKey });

      logoutBtn.addEventListener("click", async () => {
        try {
          await window.Clerk.signOut({ redirectUrl: "/" });
        } catch (e) {
          console.error(e);
          alert("Failed to sign out.");
        }
      });

      const user = window.Clerk.user;
      if (user) {
        await loadLibraryOrPaywall();
        return;
      }

      // Not signed in -> show auth UI
      showAuth();
      setStatus("");

      const params = new URLSearchParams(location.search);
      if (params.get("signup") === "1") {
        await mountSignUp();
      } else {
        await mountSignIn();
      }
    } catch (err) {
      console.error(err);
      showAuth();

      const msg = String(err?.message || err);
      showError(msg);
      setStatus("");
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(s) {
    return escapeHtml(s);
  }

  boot();
})();
