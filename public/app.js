/* public/app.js
   Robust Clerk loader + mount + basic signed-in UI.
   - Fetches publishable key from /api/config
   - Loads Clerk script with fallback if js.clerk.com fails
*/

const $ = (id) => document.getElementById(id);

const authBox = $("authBox");
const appBox = $("appBox");
const authStatus = $("authStatus");
const authError = $("authError");
const appContent = $("appContent");
const logoutBtn = $("logoutBtn");

function setStatus(text) {
  authStatus.textContent = text || "";
}

function setError(text) {
  authError.textContent = text || "";
}

function showAuthedUI() {
  authBox.style.display = "none";
  appBox.style.display = "";
  logoutBtn.style.display = "";
}

function showLoginUI() {
  authBox.style.display = "";
  appBox.style.display = "none";
  logoutBtn.style.display = "none";
}

async function fetchConfig() {
  const res = await fetch("/api/config", { credentials: "include" });
  if (!res.ok) throw new Error(`/api/config failed (${res.status})`);
  return res.json();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve(src);
    s.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(s);
  });
}

async function loadClerkScriptWithFallback() {
  const candidates = [
    "https://js.clerk.com/v4/clerk.browser.js",
    // Fallback (if js.clerk.com has DNS/CDN issues)
    "https://unpkg.com/@clerk/clerk-js@latest/dist/clerk.browser.js",
  ];

  let lastErr = null;
  for (const url of candidates) {
    try {
      const loaded = await loadScript(url);
      return loaded;
    } catch (e) {
      lastErr = e;
      // try next
    }
  }
  throw lastErr || new Error("Failed to load Clerk script");
}

function getPlanFromUrl() {
  const url = new URL(window.location.href);
  const plan = url.searchParams.get("plan");
  return plan && ["monthly", "yearly"].includes(plan) ? plan : null;
}

async function mountClerk(publishableKey) {
  if (!window.Clerk) {
    throw new Error("Clerk global not found after script load.");
  }

  // NOTE: v4 uses Clerk.load({ publishableKey })
  await window.Clerk.load({ publishableKey });

  // Mount Clerk sign-in UI
  const mountEl = $("clerkMount");
  if (!mountEl) {
    throw new Error("Missing #clerkMount in app.html");
  }

  // Clean mount in case of reload
  mountEl.innerHTML = "";

  // Use SignIn component
  window.Clerk.mountSignIn(mountEl, {
    routing: "hash",
    signUpUrl: "/app",
    afterSignInUrl: "/app",
    afterSignUpUrl: "/app",
  });

  // Logout button
  logoutBtn.onclick = async () => {
    try {
      await window.Clerk.signOut();
      // hard refresh to reset state
      window.location.href = "/app";
    } catch (e) {
      console.error(e);
      setError("Logout failed.");
    }
  };
}

async function renderAppIfSignedIn() {
  // Clerk might not be ready immediately
  const clerk = window.Clerk;
  if (!clerk) return;

  const isSignedIn = !!clerk.user;
  if (!isSignedIn) {
    showLoginUI();
    setStatus("Not logged in.");
    return;
  }

  showAuthedUI();
  setStatus("");

  // Simple “you are logged in” indicator
  const email =
    clerk.user?.primaryEmailAddress?.emailAddress ||
    clerk.user?.emailAddresses?.[0]?.emailAddress ||
    "(no email)";
  appContent.innerHTML = `
    <div class="muted" style="margin-bottom:10px;">
      Logged in as <strong>${escapeHtml(email)}</strong>
    </div>
    <div id="postLoginArea" class="muted">Loading…</div>
  `;

  const plan = getPlanFromUrl();
  const postLoginArea = document.getElementById("postLoginArea");

  if (plan) {
    // If you already have a backend endpoint to create checkout:
    // You can implement /api/create-checkout-session?plan=monthly|yearly
    postLoginArea.textContent = `Plan selected: ${plan}. Starting checkout…`;

    try {
      const r = await fetch(`/api/create-checkout-session?plan=${encodeURIComponent(plan)}`, {
        method: "POST",
        credentials: "include",
        headers: {
          // Optional: if you verify Clerk tokens server-side later
          // "Authorization": `Bearer ${await clerk.session?.getToken()}`
        },
      });

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`Checkout failed (${r.status}): ${t}`);
      }

      const data = await r.json();
      if (!data || !data.url) throw new Error("Missing checkout URL from backend.");

      window.location.href = data.url;
      return;
    } catch (e) {
      console.error(e);
      postLoginArea.textContent = "Checkout failed. See console.";
      return;
    }
  }

  // Default “library” area (replace later with your API call)
  postLoginArea.innerHTML = `
    <div style="margin-top:8px;">
      ✅ You are logged in. Next step: load your library content here.
    </div>
  `;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&#039;";
      default: return c;
    }
  });
}

async function main() {
  try {
    setError("");
    showLoginUI();
    setStatus("Loading configuration…");

    const cfg = await fetchConfig();
    const publishableKey = cfg?.clerkPublishableKey;

    if (!publishableKey || typeof publishableKey !== "string") {
      throw new Error("Missing clerkPublishableKey from /api/config");
    }

    setStatus("Loading Clerk…");
    await loadClerkScriptWithFallback();

    setStatus("Initializing Clerk…");
    await mountClerk(publishableKey);

    // Keep UI in sync
    // Clerk emits events; but simplest: poll small period after init
    setStatus("Ready.");
    await renderAppIfSignedIn();

    // Re-check on navigation/hash changes or after sign-in flow
    window.addEventListener("hashchange", () => renderAppIfSignedIn());
    window.addEventListener("focus", () => renderAppIfSignedIn());

    // Also listen to Clerk events if available
    if (window.Clerk?.addListener) {
      window.Clerk.addListener(() => renderAppIfSignedIn());
    }
  } catch (e) {
    console.error(e);
    showLoginUI();

    // Show the most useful error to you
    setStatus("");
    setError(e?.message || "Authentication failed to load.");

    // If script load failed, make that super obvious
    if ((e?.message || "").includes("Failed to load script")) {
      setError(
        (e?.message || "") +
        " — This is usually DNS/adblock/network blocking. Try switching network or disable blockers, or we keep the unpkg fallback."
      );
    }
  }
}

main();
