(() => {
  const $ = (id) => document.getElementById(id);

  const authBox = $("authBox");
  const appBox = $("appBox");
  const authStatus = $("authStatus");
  const authError = $("authError");
  const clerkMount = $("clerk-components");
  const logoutBtn = $("logoutBtn");
  const appContent = $("appContent");

  const APP_URL = "/app"; // you are serving /app as the page (Cloudflare Pages)

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

  async function fetchPublishableKey() {
    const res = await fetch("/api/config", {
      method: "GET",
      cache: "no-store",
      headers: { "Accept": "application/json" },
    });

    if (!res.ok) throw new Error(`Failed to fetch /api/config (${res.status})`);
    const data = await res.json();

    if (!data || typeof data.clerkPublishableKey !== "string" || !data.clerkPublishableKey.startsWith("pk_")) {
      throw new Error("Invalid or missing clerkPublishableKey from /api/config");
    }
    return data.clerkPublishableKey;
  }

  async function getAuthToken() {
    // Requires Clerk.load() already done
    const session = window.Clerk.session;
    if (!session) return null;

    // Default template works if you used Clerk JWT template defaults;
    // If you created a custom JWT template name in Clerk, set it here:
    // return await session.getToken({ template: "YOUR_TEMPLATE_NAME" });
    return await session.getToken();
  }

  async function apiFetch(path, opts = {}) {
    const token = await getAuthToken();
    if (!token) {
      const err = new Error("Not logged in.");
      err.status = 401;
      throw err;
    }

    const headers = new Headers(opts.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");

    return fetch(path, { ...opts, headers });
  }

  function renderSignedIn(user, access) {
    showApp();

    const email =
      user?.primaryEmailAddress?.emailAddress ||
      user?.emailAddresses?.[0]?.emailAddress ||
      user?.username ||
      "Unknown";

    if (access?.hasPaid) {
      appContent.innerHTML = `
        <p class="muted">Logged in as: <strong>${email}</strong></p>
        <p style="margin-top:10px;">✅ Subscription active (${access.plan || "paid"}).</p>
        <div style="margin-top:14px;">
          <a class="toplink" href="/" style="display:inline-block;">Go to homepage</a>
        </div>
      `;
      return;
    }

    // Not paid -> show paywall + buttons
    appContent.innerHTML = `
      <p class="muted">Logged in as: <strong>${email}</strong></p>
      <p style="margin-top:10px;">🔒 Your plan is not active yet. Choose a subscription:</p>

      <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:14px;">
        <button id="buyMonthly" class="toplink">Start Monthly</button>
        <button id="buyYearly" class="toplink">Start Yearly</button>
      </div>

      <p class="muted" style="margin-top:12px;">After payment you’ll return here automatically.</p>
      <p id="payError" class="muted" style="margin-top:12px;color:#b00020;"></p>
    `;

    const payError = document.getElementById("payError");

    async function startCheckout(plan) {
      try {
        payError.textContent = "";
        const res = await apiFetch("/api/create-checkout-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plan,
            // send user back to /app after Stripe
            successUrl: `${location.origin}${APP_URL}?success=1`,
            cancelUrl: `${location.origin}${APP_URL}?canceled=1`,
          }),
        });

        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`Checkout failed (${res.status}): ${txt}`);
        }

        const data = await res.json();
        if (!data?.url) throw new Error("Missing checkout url from server.");
        location.href = data.url;
      } catch (e) {
        console.error(e);
        payError.textContent = String(e?.message || e);
      }
    }

    document.getElementById("buyMonthly").addEventListener("click", () => startCheckout("monthly"));
    document.getElementById("buyYearly").addEventListener("click", () => startCheckout("yearly"));
  }

  async function mountSignIn() {
    clerkMount.innerHTML = "";
    await window.Clerk.mountSignIn(clerkMount, {
      signUpUrl: APP_URL,
      afterSignInUrl: APP_URL,
      afterSignUpUrl: APP_URL,
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
      if (!user) {
        showAuth();
        setStatus("");
        await mountSignIn();
        return;
      }

      // Signed in -> ask backend if user has paid access
      setStatus("");

      let access = null;
      try {
        const res = await apiFetch("/api/library", { method: "GET" });
        if (res.ok) {
          access = await res.json();
        } else if (res.status === 401) {
          // token missing/invalid
          throw new Error("Not logged in.");
        } else {
          const txt = await res.text();
          throw new Error(`Failed to load library (${res.status}): ${txt}`);
        }
      } catch (e) {
        console.error(e);
        // still allow rendering as not paid if backend errors
        access = { hasPaid: false };
      }

      renderSignedIn(user, access);
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
