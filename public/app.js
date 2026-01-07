(() => {
  const $ = (id) => document.getElementById(id);

  const authBox = $("authBox");
  const appBox = $("appBox");
  const authStatus = $("authStatus");
  const authError = $("authError");
  const clerkMount = $("clerk-components");
  const logoutBtn = $("logoutBtn");
  const appContent = $("appContent");

  // Håll /app (route) som din app-sida. (Du använder redan /app i prod.)
  const APP_URL = "/app";

  // ✅ Publishable key är OK att exponera (det är så Clerk fungerar).
  // Byt gärna till env via /api/config senare, men först: stabilt.
  const CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsua25vd3N0cmlkZS5jb20k";

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

  async function waitForClerkGlobal(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.Clerk && typeof window.Clerk.load === "function") return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Clerk script loaded but window.Clerk is still missing.");
  }

  function renderSignedIn(user) {
    showApp();
    appContent.innerHTML = `
      <p class="muted">Logged in as: <strong>${user?.primaryEmailAddress?.emailAddress || user?.username || "Unknown"}</strong></p>
      <p style="margin-top:10px;">✅ Auth works. Next step is to protect paid content / plans with Stripe.</p>
    `;
  }

  async function mountSignIn() {
    clerkMount.innerHTML = "";
    await window.Clerk.mountSignIn(clerkMount, {
      signUpUrl: APP_URL,
      afterSignInUrl: APP_URL,
      afterSignUpUrl: APP_URL,
    });
  }

  async function mountSignUp() {
    clerkMount.innerHTML = "";
    await window.Clerk.mountSignUp(clerkMount, {
      signInUrl: APP_URL,
      afterSignInUrl: APP_URL,
      afterSignUpUrl: APP_URL,
    });
  }

  async function boot() {
    try {
      showError("");
      setStatus("Loading authentication…");

      // 1) Vänta på Clerk global (scripten är defer)
      await waitForClerkGlobal();

      // 2) Ladda Clerk med publishableKey explicit (stabilast över browsers + cache)
      await window.Clerk.load({ publishableKey: CLERK_PUBLISHABLE_KEY });

      // Logout
      logoutBtn.addEventListener("click", async () => {
        try {
          await window.Clerk.signOut({ redirectUrl: "/" });
        } catch (e) {
          console.error(e);
          alert("Failed to sign out.");
        }
      });

      // 3) Visa rätt UI
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

      const msg = String(err?.message || err);
      showError(msg);
      setStatus("");
    }
  }

  boot();
})();
