// public/app.js
(function () {
  const $ = (id) => document.getElementById(id);

  const authStatusEl = $("authStatus");
  const authErrorEl = $("authError");
  const clerkMount = $("clerk-components");
  const authBox = $("authBox");
  const appBox = $("appBox");
  const appTitle = $("appTitle");
  const appContent = $("appContent");
  const logoutBtn = $("logoutBtn");

  const qs = new URLSearchParams(window.location.search);
  const plan = (qs.get("plan") || "").toLowerCase();          // monthly/yearly/3y/6y/9y
  const success = qs.get("success") === "1";
  const canceled = qs.get("canceled") === "1";

  function setError(msg) {
    authErrorEl.textContent = msg || "";
  }

  function setStatus(msg) {
    authStatusEl.textContent = msg || "";
  }

  async function fetchConfig() {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok) throw new Error("Could not load /api/config");
    return await res.json();
  }

  // Load Clerk JS with fallback CDNs (fixar ERR_NAME_NOT_RESOLVED / CDN-block)
  function loadClerkScript() {
    const urls = [
      "https://js.clerk.com/v4/clerk.browser.js",
      "https://unpkg.com/@clerk/clerk-js@4/dist/clerk.browser.js",
      "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@4/dist/clerk.browser.js",
    ];

    return new Promise((resolve, reject) => {
      let i = 0;

      const tryNext = () => {
        if (i >= urls.length) {
          reject(new Error("Clerk script could not be loaded (all CDNs failed)."));
          return;
        }

        const url = urls[i++];
        const s = document.createElement("script");
        s.async = true;
        s.src = url;

        s.onload = () => resolve(url);
        s.onerror = () => {
          s.remove();
          tryNext();
        };

        document.head.appendChild(s);
      };

      tryNext();
    });
  }

  function appUrlWithParams(extra = {}) {
    const base = "/app";
    const p = new URLSearchParams(window.location.search);

    // se till att vi alltid behåller plan om det finns
    if (plan) p.set("plan", plan);

    // lägg/ersätt extras
    for (const [k, v] of Object.entries(extra)) {
      if (v === null || v === undefined || v === "") p.delete(k);
      else p.set(k, String(v));
    }

    const q = p.toString();
    return q ? `${base}?${q}` : base;
  }

  async function startCheckout(plan) {
    // Starta Stripe Checkout via din Cloudflare Pages Function
    const res = await fetch("/api/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Checkout failed.");
    if (!data?.url) throw new Error("Checkout URL missing.");
    window.location.href = data.url;
  }

  async function mountClerkUI() {
    setStatus("Loading authentication…");
    setError("");

    const cfg = await fetchConfig();
    const publishableKey = (cfg && cfg.clerkPublishableKey) ? String(cfg.clerkPublishableKey).trim() : "";

    if (!publishableKey || !publishableKey.startsWith("pk_")) {
      throw new Error("Invalid Clerk publishable key from /api/config.");
    }

    await loadClerkScript();

    if (!window.Clerk) {
      throw new Error("Clerk global not found after script load.");
    }

    // Viktigt: efterSignIn ska tillbaka till /app (inte /)
    const afterAuthUrl = appUrlWithParams({}); // behåller ?plan=...

    await window.Clerk.load({
      publishableKey,
      afterSignInUrl: afterAuthUrl,
      afterSignUpUrl: afterAuthUrl,
      signInUrl: "/app",
      signUpUrl: "/app",
    });

    // Log out-knapp
    logoutBtn.onclick = async () => {
      try {
        await window.Clerk.signOut();
      } finally {
        window.location.href = "/";
      }
    };

    // Om inloggad
    if (window.Clerk.user) {
      logoutBtn.style.display = "inline-block";
      authBox.style.display = "none";
      appBox.style.display = "block";

      const email =
        window.Clerk.user.primaryEmailAddress?.emailAddress ||
        window.Clerk.user.emailAddresses?.[0]?.emailAddress ||
        "user";

      appTitle.textContent = `Welcome, ${email}`;
      appContent.innerHTML = "";

      if (success) {
        appContent.innerHTML += `<p><b>✅ Payment successful!</b> Your access should now be active.</p>`;
      } else if (canceled) {
        appContent.innerHTML += `<p><b>ℹ️ Payment canceled.</b> You can try again.</p>`;
      } else {
        appContent.innerHTML += `<p class="muted">You are signed in.</p>`;
      }

      // Om man kommer hit med ?plan=monthly → starta checkout automatiskt (bara om inte success/canceled)
      if (plan && !success && !canceled) {
        appContent.innerHTML += `<p class="muted">Redirecting to checkout…</p>`;
        await startCheckout(plan);
      }

      return;
    }

    // Inte inloggad: mounta sign-in UI
    logoutBtn.style.display = "none";
    authBox.style.display = "block";
    appBox.style.display = "none";
    setStatus("Not logged in.");

    // Visa inlogg (och se till att OAuth kommer tillbaka till /app?plan=...)
    // redirectUrl hjälper ofta mot att man “studsar” fel efter Google OAuth
    const redirectUrl = appUrlWithParams({});
    window.Clerk.mountSignIn(clerkMount, {
      redirectUrl,
      afterSignInUrl: redirectUrl,
      signUpUrl: "/app",
    });
  }

  async function main() {
    try {
      await mountClerkUI();
    } catch (e) {
      console.error(e);
      setStatus("");
      setError(e?.message || String(e) || "Authentication failed to load.");
    }
  }

  main();
})();
