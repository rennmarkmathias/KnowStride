(function () {
  const authStatus = document.getElementById("authStatus");
  const authError = document.getElementById("authError");
  const clerkMount = document.getElementById("clerkMount");
  const authBox = document.getElementById("authBox");
  const appBox = document.getElementById("appBox");
  const logoutBtn = document.getElementById("logoutBtn");
  const appContent = document.getElementById("appContent");

  function setStatus(msg) { if (authStatus) authStatus.textContent = msg || ""; }
  function setError(msg) { if (authError) authError.textContent = msg || ""; }

  function showSignedOutUI() {
    if (authBox) authBox.style.display = "";
    if (appBox) appBox.style.display = "none";
    if (logoutBtn) logoutBtn.style.display = "none";
  }

  function showAuthedUI() {
    if (authBox) authBox.style.display = "none";
    if (appBox) appBox.style.display = "";
    if (logoutBtn) logoutBtn.style.display = "";
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
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load script: " + src));
      document.head.appendChild(s);
    });
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function init() {
    try {
      if (!clerkMount) throw new Error("Missing #clerkMount in app.html");

      showSignedOutUI();
      setError("");

      setStatus("Loading config…");
      const cfg = await fetchConfig();
      const publishableKey = cfg && cfg.clerkPublishableKey;
      if (!publishableKey) throw new Error("Missing clerkPublishableKey from /api/config");

      // Force stable CDN (avoids js.clerk.com DNS issues)
      setStatus("Loading Clerk…");
      const clerkCdn = "https://unpkg.com/@clerk/clerk-js@latest/dist/clerk.browser.js";
      await loadScript(clerkCdn);

      if (!window.Clerk) throw new Error("Clerk global not found after script load.");

      window.Clerk.load({ publishableKey });
      await window.Clerk.loaded;

      if (!window.Clerk.user) {
        setStatus("Not logged in.");
        window.Clerk.mountSignIn(clerkMount, {
          redirectUrl: "/app",
          afterSignInUrl: "/app",
          signUpUrl: "/app?mode=signup",
        });

        const url = new URL(window.location.href);
        if (url.searchParams.get("mode") === "signup") {
          window.Clerk.unmountSignIn(clerkMount);
          window.Clerk.mountSignUp(clerkMount, {
            redirectUrl: "/app",
            afterSignUpUrl: "/app",
            signInUrl: "/app",
          });
        }
        return;
      }

      showAuthedUI();
      setStatus("");

      logoutBtn.onclick = async () => {
        await window.Clerk.signOut();
        window.location.href = "/app";
      };

      const email = window.Clerk.user.primaryEmailAddress?.emailAddress || "user";
      appContent.innerHTML = `<p class="muted">Logged in as <strong>${escapeHtml(email)}</strong></p>`;
    } catch (e) {
      console.error(e);
      showSignedOutUI();
      setStatus("");
      setError((e && e.message) ? e.message : "Authentication failed to load.");
    }
  }

  init();
})();
