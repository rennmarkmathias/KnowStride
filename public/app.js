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
    console.log("Config response from /api/config:", data);

    const key = data?.clerkPublishableKey;
    if (typeof key !== "string" || !key.startsWith("pk_")) {
      throw new Error("Invalid or missing clerkPublishableKey from /api/config");
    }
    return key;
  }

  function loadClerkScript(publishableKey) {
    return new Promise((resolve, reject) => {
      // Om den redan finns (t.ex. vid reload), återanvänd
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

      // VIKTIGT: publishable key måste finnas VID script-load
      s.setAttribute("data-clerk-publishable-key", publishableKey);

      // Markera så vi kan hitta scriptet vid reload
      s.setAttribute("data-knowstride-clerk", "1");

      // Använd unpkg (eftersom js.clerk.com varit strul hos dig)
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

  function renderSignedIn(user) {
    showApp();
    appContent.innerHTML = `
      <p class="muted">Logged in as: <strong>${
        user?.primaryEmailAddress?.emailAddress || user?.username || "Unknown"
      }</strong></p>
      <p style="margin-top:10px;">✅ Auth works. Next step: protect paid content / plans with Stripe.</p>
    `;
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

      // 1) Hämta nyckeln först
      const publishableKey = await fetchPublishableKey();

      // 2) Ladda Clerk-scriptet med data-clerk-publishable-key
      await loadClerkScript(publishableKey);

      // 3) Vänta tills Clerk verkligen initat
      await waitForClerkGlobal();

      // 4) (Valfritt men bra) kör load utan key (key kom via data-attribut)
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
      if (user) {
        setStatus("");
        renderSignedIn(user);
        return;
      }

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
      showError(String(err?.message || err));
      setStatus("");
    }
  }

  boot();
})();
