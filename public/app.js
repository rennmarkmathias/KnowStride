/* public/app.js
   Vanilla Clerk integration with:
   - publishableKey fetched from /api/config
   - robust Clerk script loading with fallback CDN
   - NO auto-bounce back to "/" when signed out
*/

(function () {
  const els = {
    authBox: document.getElementById("authBox"),
    appBox: document.getElementById("appBox"),
    authStatus: document.getElementById("authStatus"),
    authError: document.getElementById("authError"),
    clerkMount: document.getElementById("clerkMount"),
    logoutBtn: document.getElementById("logoutBtn"),
    appContent: document.getElementById("appContent"),
  };

  function setAuthError(msg) {
    els.authError.textContent = msg || "";
  }

  function setStatus(msg) {
    els.authStatus.textContent = msg || "";
  }

  function showAuthedUI() {
    els.authBox.style.display = "none";
    els.appBox.style.display = "";
    els.logoutBtn.style.display = "";
  }

  function showSignedOutUI() {
    els.appBox.style.display = "none";
    els.logoutBtn.style.display = "none";
    els.authBox.style.display = "";
  }

  async function fetchConfig() {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to fetch /api/config");
    return await res.json();
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.crossOrigin = "anonymous";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load script: " + src));
      document.head.appendChild(s);
    });
  }

  async function loadClerkScriptWithFallback() {
    // Primary (official)
    const primary = "https://js.clerk.com/v4/clerk.browser.js";
    // Fallback (if js.clerk.com is DNS-blocked)
    const fallback = "https://unpkg.com/@clerk/clerk-js@latest/dist/clerk.browser.js";

    try {
      await loadScript(primary);
      return { used: primary };
    } catch (e1) {
      console.warn(e1);
      await loadScript(fallback);
      return { used: fallback };
    }
  }

  function currentPlanFromUrl() {
    const url = new URL(window.location.href);
    return url.searchParams.get("plan"); // e.g. monthly/yearly
  }

  function rememberPlan(plan) {
    try {
      if (plan) sessionStorage.setItem("pending_plan", plan);
    } catch (_) {}
  }

  function consumeRememberedPlan() {
    try {
      const p = sessionStorage.getItem("pending_plan");
      if (p) sessionStorage.removeItem("pending_plan");
      return p || null;
    } catch (_) {
      return null;
    }
  }

  function safeMountGuard() {
    if (!els.clerkMount) {
      throw new Error("Missing #clerkMount in app.html");
    }
  }

  async function init() {
    try {
      safeMountGuard();
      setAuthError("");
      showSignedOutUI();

      // If user came here via /buy plan -> /app?plan=monthly, store it until auth completes
      const planInUrl = currentPlanFromUrl();
      if (planInUrl) rememberPlan(planInUrl);

      setStatus("Loading config…");
      const cfg = await fetchConfig();
      const publishableKey = cfg && cfg.clerkPublishableKey;

      if (!publishableKey || typeof publishableKey !== "string") {
        throw new Error("Missing clerkPublishableKey from /api/config");
      }

      setStatus("Loading Clerk…");
      const loaded = await loadClerkScriptWithFallback();
      console.log("Clerk script loaded from:", loaded.used);

      if (!window.Clerk) {
        throw new Error("Clerk global not found after script load.");
      }

      // Init Clerk
      window.Clerk.load({ publishableKey });

      // Wait until Clerk is ready
      await window.Clerk.loaded;

      // Important: DO NOT bounce to "/" when signed out. Just render sign-in.
      const signedIn = !!window.Clerk.user;

      if (!signedIn) {
        showSignedOutUI();
        setStatus("Not logged in.");

        // Mount sign-in inside this page.
        // Use redirectUrl/afterSignInUrl to stay on /app.
        window.Clerk.mountSignIn(els.clerkMount, {
          redirectUrl: "/app",
          afterSignInUrl: "/app",
          signUpUrl: "/app?mode=signup",
        });

        // If user has mode=signup, mount sign-up instead
        const url = new URL(window.location.href);
        const mode = url.searchParams.get("mode");
        if (mode === "signup") {
          window.Clerk.unmountSignIn(els.clerkMount);
          window.Clerk.mountSignUp(els.clerkMount, {
            redirectUrl: "/app",
            afterSignUpUrl: "/app",
            signInUrl: "/app",
          });
        }

        return;
      }

      // Signed in:
      showAuthedUI();
      setStatus("");
      setAuthError("");

      els.logoutBtn.onclick = async () => {
        try {
          await window.Clerk.signOut();
          // Reload to show sign-in again
          window.location.href = "/app";
        } catch (e) {
          console.error(e);
          alert("Logout failed.");
        }
      };

      // Render a small "logged in" UI (replace with your real library UI)
      const pendingPlan = planInUrl || consumeRememberedPlan();
      els.appContent.innerHTML = `
        <p class="muted">Logged in as <strong>${escapeHtml(window.Clerk.user.primaryEmailAddress?.emailAddress || "user")}</strong></p>
        ${pendingPlan ? `<p style="margin-top:10px;">Plan selected: <strong>${escapeHtml(pendingPlan)}</strong> (hook checkout here)</p>` : ""}
        <p style="margin-top:10px;" class="muted">If you still bounce back to the homepage, it was caused by the old redirect logic. This file removes that.</p>
      `;

      // TODO: Here you call your checkout flow once you have it:
      // if (pendingPlan) startCheckout(pendingPlan);

    } catch (err) {
      console.error(err);

      // Make error visible in UI
      showSignedOutUI();
      setStatus("");
      setAuthError(err && err.message ? err.message : "Authentication failed to load.");

      // Add a clearer hint for the most common issue you show in screenshots:
      // DNS / blocked js.clerk.com -> fallback should fix, but if both blocked, user must allow one.
      if (String(err?.message || "").includes("Failed to load script")) {
        els.authError.textContent =
          (err.message || "Failed to load Clerk.") +
          " (Try opening https://js.clerk.com/v4/clerk.browser.js directly. If it cannot be reached, your DNS/network blocks it.)";
      }
    }
  }

  // Basic HTML escaping for injected content
  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  init();
})();
