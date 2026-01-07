(() => {
  const $ = (id) => document.getElementById(id);

  const authBox = $("authBox");
  const appBox = $("appBox");
  const authStatus = $("authStatus");
  const authError = $("authError");
  const clerkMount = $("clerk-components");
  const logoutBtn = $("logoutBtn");
  const appContent = $("appContent");

  // Håll detta till /app (inte /app.html) om du använder /app i prod.
  // Om du vill köra /app.html istället: byt alla APP_URL till "/app.html"
  const APP_URL = "/app";

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

  function renderSignedIn(user) {
    showApp();
    appContent.innerHTML = `
      <p class="muted">Logged in as: <strong>${user?.primaryEmailAddress?.emailAddress || user?.username || "Unknown"}</strong></p>
      <p style="margin-top:10px;">✅ Auth works. Next step is to protect paid content / plans with Stripe.</p>
    `;
  }

  function waitForClerkGlobal(timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();

      (function tick() {
        if (window.Clerk && typeof window.Clerk.load === "function") return resolve();
        if (Date.now() - start > timeoutMs) {
          return reject(new Error("Clerk script loaded but window.Clerk is still missing."));
        }
        setTimeout(tick, 50);
      })();
    });
  }

  async function mountSignIn() {
    clerkMount.innerHTML = "";
    await window.Clerk.mountSignIn(clerkMount, {
      signUpUrl: APP_URL + "?signup=1",
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

      // 1) Vänta på att Clerk verkligen finns
      await waitForClerkGlobal();

      // 2) Ladda Clerk — publishable key tas nu från script-taggen (data-clerk-publishable-key)
      await window.Clerk.load();

      // Logout
      logoutBtn.addEventListener("click", async () => {
        try {
          await window.Clerk.signOut({ redirectUrl: "/" });
        } catch (e) {
          console.error(e);
          alert("Failed to sign out.");
        }
      });

      // 3) Inloggad?
      const user = window.Clerk.user;
      if (user) {
        setStatus("");
        renderSignedIn(user);
        return;
      }

      // 4) Visa auth UI
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
