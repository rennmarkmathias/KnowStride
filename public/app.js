(() => {
  const $ = (id) => document.getElementById(id);

  const authBox = $("authBox");
  const appBox = $("appBox");
  const authStatus = $("authStatus");
  const authError = $("authError");
  const clerkMount = $("clerk-components");
  const logoutBtn = $("logoutBtn");
  const appContent = $("appContent");

  // Använd /app.html som "sanna" URL tills allt är stabilt
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
      headers: {
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch /api/config (${res.status})`);
    }

    const data = await res.json();

    console.log("Config response from /api/config:", data);

    if (
      !data ||
      typeof data.clerkPublishableKey !== "string" ||
      !data.clerkPublishableKey.startsWith("pk_")
    ) {
      throw new Error("Invalid or missing clerkPublishableKey from /api/config");
    }

    return data.clerkPublishableKey;
  }

  async function waitForClerkGlobal(timeoutMs = 12000) {
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
      <p class="muted">Logged in as: <strong>${
        user?.primaryEmailAddress?.emailAddress || user?.username || "Unknown"
      }</strong></p>
      <p style="margin-top:10px;">✅ Auth works. Next step is to protect paid content / plans with your existing Stripe logic.</p>
    `;
  }

  async function mountSignIn() {
    clerkMount.innerHTML = "";
    await window.Clerk.mountSignIn(clerkMount, {
      appearance: { elements: {} },
      // Tips: om du vill kunna tvinga signup-vy via länk
      signUpUrl: `${APP_URL}?signup=1`,
      redirectUrl: APP_URL,
      afterSignInUrl: APP_URL,
      afterSignUpUrl: APP_URL,
    });
  }

  async function mountSignUp() {
    clerkMount.innerHTML = "";
    await window.Clerk.mountSignUp(clerkMount, {
      appearance: { elements: {} },
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

      // 1) Vänta tills Clerk global finns (script är defer i app.html)
      await waitForClerkGlobal();

      // 2) Hämta publishable key
      const publishableKey = await fetchPublishableKey();

      // 3) Ladda Clerk
      await window.Clerk.load({ publishableKey });

      // Logout-knapp
      logoutBtn.addEventListener("click", async () => {
        try {
          await window.Clerk.signOut({ redirectUrl: "/" });
        } catch (e) {
          console.error(e);
          alert("Failed to sign out.");
        }
      });

      // 4) Avgör vad som ska visas
      const user = window.Clerk.user;
      if (user) {
        setStatus("");
        renderSignedIn(user);
        return;
      }

      // Inte inloggad -> visa auth UI
      showAuth();
      setStatus("");

      // Om URL har ?signup=1, visa sign-up istället
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
      if (msg.toLowerCase().includes("clerk script")) {
        showError("Clerk failed to load. (Script/CDN issue)");
      } else {
        showError(msg);
      }
      setStatus("");
    }
  }

  boot();
})();
