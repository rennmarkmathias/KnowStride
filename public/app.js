(() => {
  const $ = (id) => document.getElementById(id);

  const authBox = $("authBox");
  const appBox = $("appBox");
  const authStatus = $("authStatus");
  const authError = $("authError");
  const clerkMount = $("clerk-components");
  const logoutBtn = $("logoutBtn");
  const appContent = $("appContent");

  const APP_URL = "/app.html";

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

  async function fetchPublishableKey() {
    const res = await fetch("/api/config", {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Failed to fetch /api/config (${res.status})`);
    const data = await res.json();
    const key = data?.clerkPublishableKey;
    if (typeof key !== "string" || !key.startsWith("pk_")) {
      throw new Error("Invalid or missing clerkPublishableKey from /api/config");
    }
    return key;
  }

  function loadClerkScript(publishableKey) {
    return new Promise((resolve, reject) => {
      if (window.Clerk) return resolve();

      const existing = document.querySelector('script[data-knowstride-clerk="1"]');
      if (existing) {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("Failed to load Clerk script")));
        return;
      }

      const s = document.createElement("script");
      s.async = true;
      s.crossOrigin = "anonymous";
      s.setAttribute("data-clerk-publishable-key", publishableKey);
      s.setAttribute("data-knowstride-clerk", "1");
      s.src = "https://unpkg.com/@clerk/clerk-js@latest/dist/clerk.browser.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load Clerk script (network/CDN)"));
      document.head.appendChild(s);
    });
  }

  async function waitForClerkGlobal(timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.Clerk && typeof window.Clerk.mountSignIn === "function") return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Clerk did not initialize (window.Clerk missing).");
  }

  async function getAuthToken() {
    // Kräver en aktiv session
    const sess = window.Clerk?.session;
    if (!sess || typeof sess.getToken !== "function") return null;
    return await sess.getToken();
  }

  async function apiFetch(path, { method = "GET", body } = {}) {
    const token = await getAuthToken();
    if (!token) throw new Error("No session token (not logged in).");

    const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const res = await fetch(path, { method, headers, body: payload, cache: "no-store" });
    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const msg = data?.error || `${res.status} ${res.statusText}`;
      throw new Error(msg);
    }
    return data;
  }

  function planButtonsHtml() {
    const plans = [
      { id: "monthly", label: "Monthly" },
      { id: "yearly", label: "Yearly" },
      { id: "3y", label: "3 years" },
      { id: "6y", label: "6 years" },
      { id: "9y", label: "9 years" },
    ];

    return `
      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
        ${plans
          .map(
            (p) => `
          <button class="toplink" data-plan="${p.id}" style="padding:10px 14px; border-radius:12px;">
            Buy ${p.label}
          </button>`
          )
          .join("")}
      </div>
      <p class="muted" style="margin-top:10px;">
        When payment completes, you’ll be redirected back here and access unlocks automatically.
      </p>
    `;
  }

  async function startCheckout(plan) {
    // Skapar Stripe Checkout Session via din Pages Function
    const data = await apiFetch("/api/create-checkout-session", {
      method: "POST",
      body: { plan },
    });

    if (!data?.url) throw new Error("Stripe session URL missing.");
    window.location.href = data.url;
  }

  function renderPaywall(userEmail, reason) {
    showApp();
    appContent.innerHTML = `
      <p class="muted">Logged in as: <strong>${userEmail}</strong></p>
      <h3 style="margin-top:14px;">Locked</h3>
      <p class="muted" style="margin-top:6px;">
        ${reason || "You need an active plan to access the library."}
      </p>
      ${planButtonsHtml()}
    `;

    appContent.querySelectorAll("button[data-plan]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const plan = btn.getAttribute("data-plan");
        btn.disabled = true;
        btn.textContent = "Redirecting…";
        try {
          await startCheckout(plan);
        } catch (e) {
          console.error(e);
          alert(String(e?.message || e));
          btn.disabled = false;
          btn.textContent = `Buy ${plan}`;
        }
      });
    });
  }

  async function renderLibrary(userEmail) {
    showApp();

    const data = await apiFetch("/api/library");

    if (!data?.hasPaid) {
      renderPaywall(userEmail, "No active subscription found.");
      return;
    }

    const blocks = Array.isArray(data.blocks) ? data.blocks : [];
    const info = `
      <p class="muted">Logged in as: <strong>${userEmail}</strong></p>
      <p class="muted" style="margin-top:6px;">
        Access until: <strong>${data.accessUntil || "—"}</strong>
      </p>
    `;

    const list = `
      <div style="margin-top:14px;">
        <h3>Blocks</h3>
        <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">
          ${blocks
            .map(
              (b) => `
                <button class="toplink" data-block="${b.number}" style="padding:10px 14px; border-radius:12px;">
                  Block ${b.number}
                </button>`
            )
            .join("")}
        </div>
      </div>
      <div id="blockView" style="margin-top:18px;"></div>
    `;

    appContent.innerHTML = info + list;

    const blockView = $("blockView");
    appContent.querySelectorAll("button[data-block]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const n = btn.getAttribute("data-block");
        blockView.innerHTML = `<p class="muted">Loading block ${n}…</p>`;
        try {
          const r = await apiFetch(`/api/library?block=${encodeURIComponent(n)}`);
          blockView.innerHTML = r?.html || "<p class='muted'>No content.</p>";
          window.scrollTo({ top: blockView.offsetTop - 20, behavior: "smooth" });
        } catch (e) {
          console.error(e);
          blockView.innerHTML = `<p class="muted" style="color:#b00020;">${String(
            e?.message || e
          )}</p>`;
        }
      });
    });
  }

  async function mountSignIn() {
    clerkMount.innerHTML = "";
    await window.Clerk.mountSignIn(clerkMount, {
      signUpUrl: `${APP_URL}?signup=1`,
      redirectUrl: APP_URL,
      afterSignInUrl: APP_URL,
      afterSignUpUrl: APP_URL,
    });
  }

  async function mountSignUp() {
    clerkMount.innerHTML = "";
    await window.Clerk.mountSignUp(clerkMount, {
      signInUrl: APP_URL,
      redirectUrl: APP_URL,
      afterSignInUrl: APP_URL,
      afterSignUpUrl: APP_URL,
    });
  }

  async function boot() {
    try {
      showError("");
      setStatus("Loading authentication…");

      const publishableKey = await fetchPublishableKey();
      await loadClerkScript(publishableKey);
      await waitForClerkGlobal();
      await window.Clerk.load();

      logoutBtn.addEventListener("click", async () => {
        try {
          await window.Clerk.signOut({ redirectUrl: "/" });
        } catch (e) {
          console.error(e);
          alert("Failed to sign out.");
        }
      });

      const user = window.Clerk.user;
      if (!user) {
        showAuth();
        setStatus("");
        const params = new URLSearchParams(location.search);
        if (params.get("signup") === "1") await mountSignUp();
        else await mountSignIn();
        return;
      }

      // Inloggad → visa library/paywall
      setStatus("");
      const email =
        user?.primaryEmailAddress?.emailAddress || user?.username || "Unknown";

      // Om man kommer från landing med ?plan=monthly → starta checkout direkt (men bara om man inte redan har access)
      const qs = new URLSearchParams(location.search);
      const plan = (qs.get("plan") || "").toLowerCase();

      if (plan) {
        // Kolla först om redan betald — annars checkout
        const lib = await apiFetch("/api/library").catch(() => null);
        if (lib?.hasPaid) {
          await renderLibrary(email);
        } else {
          await startCheckout(plan);
        }
        return;
      }

      await renderLibrary(email);
    } catch (err) {
      console.error(err);
      showAuth();
      showError(String(err?.message || err));
      setStatus("");
    }
  }

  boot();
})();
