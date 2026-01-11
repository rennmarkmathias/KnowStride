// public/app.js

const $ = (id) => document.getElementById(id);

function getOrigin() {
  return window.location.origin;
}

function pathStartsWith(p) {
  return window.location.pathname === p || window.location.pathname.startsWith(p + "/");
}

// These should match what you set in Clerk Dashboard → Paths
const SIGN_IN_PATH = "/app";
const SIGN_UP_PATH = "/sign-up";

// After auth, send user to the library
const AFTER_AUTH_PATH = "/app";

function setAuthStatus(text) {
  const el = $("authStatus");
  if (el) el.textContent = text || "";
}

function setAuthError(text) {
  const el = $("authError");
  if (el) el.textContent = text || "";
}

function showAuth() {
  $("authBox").style.display = "";
  $("appBox").style.display = "none";
  $("logoutBtn").style.display = "none";
}

function showApp() {
  $("authBox").style.display = "none";
  $("appBox").style.display = "";
  $("logoutBtn").style.display = "";
}

async function getAuthHeaders() {
  try {
    if (window.Clerk && Clerk.session) {
      const token = await Clerk.session.getToken();
      if (token) return { Authorization: `Bearer ${token}` };
    }
  } catch (_) {}
  return {};
}

/**
 * Fetch JSON from API with Clerk auth when available.
 * If we get 401/403, retry once (token can occasionally be briefly unavailable).
 */
async function apiFetchJson(url, opts = {}, retryOnce = true) {
  const authHeaders = await getAuthHeaders();

  const res = await fetch(url, {
    ...opts,
    headers: {
      Accept: "application/json",
      ...authHeaders,
      ...(opts.headers || {}),
    },
  });

  // If unauthorized, retry once after attempting to re-read token
  if ((res.status === 401 || res.status === 403) && retryOnce) {
    // Small delay helps in rare cases where session is "just about to" be ready.
    await new Promise((r) => setTimeout(r, 250));
    return apiFetchJson(url, opts, false);
  }

  let data = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    data = await res.json().catch(() => null);
  } else {
    const text = await res.text().catch(() => "");
    data = { error: text };
  }

  if (!res.ok) {
    // Provide a nicer message for common auth issues
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        "Unauthorized. Please refresh the page and try again. If it happens again, sign out and sign in once more."
      );
    }
    const msg = data?.error || `Request failed: ${res.status}`;
    throw new Error(msg);
  }

  return data;
}

function renderPlans(container) {
  container.innerHTML = `
    <h2>Choose a plan</h2>
    <div class="plans">
      <button class="plan" data-plan="monthly">Monthly <span>$2.99</span></button>
      <button class="plan" data-plan="yearly">Yearly <span>$14.99</span></button>
      <!-- Must match server-side plan keys (functions/api/create-checkout-session.js) -->
      <button class="plan" data-plan="3y">3 years <span>$24.99</span></button>
      <button class="plan" data-plan="6y">6 years <span>$39.99</span></button>
      <button class="plan" data-plan="9y">9 years <span>$49.99</span></button>
    </div>
    <p class="muted" style="margin-top:10px;">
      After purchase, refresh will unlock the library automatically.
    </p>
  `;

  container.querySelectorAll("button.plan").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const plan = btn.getAttribute("data-plan");
      const originalHTML = btn.innerHTML;

      try {
        btn.disabled = true;
        btn.textContent = "Loading…";

        const out = await apiFetchJson("/api/create-checkout-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan }),
        });

        if (out?.url) {
          window.location.href = out.url;
        } else {
          throw new Error("Missing checkout URL from server.");
        }
      } catch (e) {
        alert(e?.message || String(e));
      } finally {
        // In case user stays on the page, restore button appearance
        btn.disabled = false;
        btn.innerHTML = originalHTML;
      }
    });
  });
}

function renderLibrary(container, items = []) {
  if (!items.length) {
    container.innerHTML = `<p class="muted">No library items available yet.</p>`;
    return;
  }

  container.innerHTML = `
    <h3>This week’s library</h3>
    <div class="library-list">
      ${items
        .map(
          (it) => `
        <div class="library-item">
          <div class="library-title">${it.title}</div>
          <a class="library-link" href="${it.url}">Open</a>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

async function loadLibrary() {
  return await apiFetchJson("/api/library");
}

async function boot() {
  showAuth();
  setAuthError("");
  setAuthStatus("Loading authentication…");

  if (!window.Clerk) {
    setAuthStatus("");
    setAuthError("Clerk failed to load.");
    return;
  }

  // Init Clerk
  await window.Clerk.load();
  const clerk = window.Clerk;

  // Logout button
  $("logoutBtn").addEventListener("click", async () => {
    await clerk.signOut({ redirectUrl: "/" });
  });

  // Decide which component to mount based on the current path
  const isSignUpPage = pathStartsWith(SIGN_UP_PATH);
  const isSignInPage = pathStartsWith(SIGN_IN_PATH);

  // If the user is not signed in → show SignIn/SignUp depending on URL
  if (!clerk.user || !clerk.session) {
    setAuthStatus("");

    const mountEl = $("clerk-components");
    mountEl.innerHTML = "";

    if (isSignUpPage) {
      clerk.mountSignUp(mountEl, {
        signInUrl: `${getOrigin()}${SIGN_IN_PATH}`,
        afterSignUpUrl: `${getOrigin()}${AFTER_AUTH_PATH}`,
        afterSignInUrl: `${getOrigin()}${AFTER_AUTH_PATH}`,
      });
    } else {
      // default to SignIn on /app (or any other page that uses this bundle)
      clerk.mountSignIn(mountEl, {
        signUpUrl: `${getOrigin()}${SIGN_UP_PATH}`,
        afterSignInUrl: `${getOrigin()}${AFTER_AUTH_PATH}`,
        afterSignUpUrl: `${getOrigin()}${AFTER_AUTH_PATH}`,
      });
    }

    return;
  }

  // User is signed in → show library / plans
  showApp();

  const appContent = $("appContent");
  appContent.innerHTML = `<p class="muted">Loading your library…</p>`;

  try {
    const data = await loadLibrary();

    // Show email & status
    const email = data?.email || clerk.user?.primaryEmailAddress?.emailAddress || "";
    const header = `
      <div style="margin-bottom:10px;">
        ${email ? `<div class="muted">Logged in as: <strong>${email}</strong></div>` : ""}
        <div style="margin-top:6px;">${
          data.accessGranted
            ? "✅ Subscription active."
            : "✅ You are signed in, but you don’t have an active subscription yet."
        }</div>
      </div>
    `;

    if (!data.accessGranted) {
      appContent.innerHTML = header;
      const wrap = document.createElement("div");
      appContent.appendChild(wrap);
      renderPlans(wrap);
      return;
    }

    appContent.innerHTML = header;
    const wrap = document.createElement("div");
    appContent.appendChild(wrap);
    renderLibrary(wrap, data.items || []);
  } catch (e) {
    appContent.innerHTML = `<p class="muted" style="color:#b00020;">${e?.message || String(e)}</p>`;
  }
}

boot().catch((e) => {
  setAuthStatus("");
  setAuthError(e?.message || String(e));
});
