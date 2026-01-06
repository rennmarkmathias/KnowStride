/* eslint-disable no-console */

/* ---------------- Small helpers ---------------- */

const $ = (id) => document.getElementById(id);

function show(id, on) {
  $(id).style.display = on ? "block" : "none";
}

function setLogoutVisible(on) {
  $("logoutBtn").style.display = on ? "inline-block" : "none";
}

function setErr(id, msg) {
  const el = $(id);
  if (!msg) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "block";
  el.textContent = msg;
}

/* ---------------- API helper ---------------- */

async function api(path, opts = {}) {
  const clerkToken = window.Clerk?.session
    ? await window.Clerk.session.getToken()
    : null;

  const headers = { ...(opts.headers || {}) };
  if (clerkToken) headers["Authorization"] = `Bearer ${clerkToken}`;

  const res = await fetch(path, { ...opts, headers });
  const txt = await res.text();

  let data;
  try {
    data = JSON.parse(txt);
  } catch {
    data = { raw: txt };
  }

  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- Clerk loader (FIX) ---------------- */

function loadScriptOnce(src, attrs = {}) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.async = true;
    s.src = src;

    Object.entries(attrs).forEach(([k, v]) => s.setAttribute(k, v));

    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error(`Failed to load script: ${src}`));
    };

    document.head.appendChild(s);
  });
}

let clerkPromise = null;

async function loadClerk() {
  if (clerkPromise) return clerkPromise;

  clerkPromise = (async () => {
    const cfg = await fetch("/api/config").then((r) => r.json());
    const pk = cfg?.clerkPublishableKey;
    if (!pk) throw new Error("Missing CLERK_PUBLISHABLE_KEY on server.");

    // IMPORTANT:
    // Use your verified Clerk custom domain FIRST.
    // Fallback to js.clerk.com if needed.
    const urls = [
      "https://clerk.knowstride.com/v4/clerk.browser.js",
      "https://js.clerk.com/v4/clerk.browser.js",
    ];

    let lastErr = null;
    for (const url of urls) {
      try {
        await loadScriptOnce(url, { "data-clerk-publishable-key": pk });
        await window.Clerk.load();
        return window.Clerk;
      } catch (e) {
        lastErr = e;
      }
    }

    throw lastErr || new Error("Failed to load Clerk.");
  })();

  return clerkPromise;
}

/* ---------------- UI flows ---------------- */

async function renderLibrary() {
  show("authBox", false);
  show("checkoutBox", false);
  show("libraryBox", true);
  setLogoutVisible(true);

  setErr("libraryErr", null);

  const meta = $("libraryMeta");
  const list = $("blocksList");
  const reader = $("reader");
  const readerTitle = $("readerTitle");

  meta.textContent = "Loading…";
  list.innerHTML = "";
  reader.innerHTML = "";
  readerTitle.textContent = "Open a block";

  const lib = await api("/api/library");

  if (!lib.hasPaid) {
    meta.textContent = "Your library is empty. Choose a plan to unlock Block 1.";
    return;
  }

  meta.textContent = `Welcome${lib.email ? `, ${lib.email}` : ""}.`;

  // Build block list
  (lib.blocks || []).forEach((b) => {
    const btn = document.createElement("button");
    btn.className = "item";
    btn.textContent = b.title || `Block ${b.index}`;
    btn.disabled = !b.unlocked;
    btn.title = b.unlocked ? "" : "Locked";

    btn.onclick = async () => {
      try {
        setErr("libraryErr", null);
        readerTitle.textContent = btn.textContent;
        reader.innerHTML = "Loading…";
        const content = await api(`/api/me?block=${encodeURIComponent(b.slug || b.index)}`);
        reader.innerHTML = content.html || content.raw || "No content.";
      } catch (e) {
        reader.innerHTML = "";
        setErr("libraryErr", e.message);
      }
    };

    list.appendChild(btn);
  });
}

async function renderCheckout() {
  show("authBox", false);
  show("checkoutBox", true);
  show("libraryBox", false);
  setLogoutVisible(true);

  setErr("checkoutErr", null);

  document.querySelectorAll("button.plan").forEach((btn) => {
    btn.onclick = async () => {
      try {
        setErr("checkoutErr", null);
        btn.disabled = true;

        const plan = btn.getAttribute("data-plan");
        const session = await api("/api/create-checkout-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan }),
        });

        if (!session?.url) throw new Error("Missing Stripe checkout URL.");
        window.location.href = session.url;
      } catch (e) {
        setErr("checkoutErr", e.message);
      } finally {
        btn.disabled = false;
      }
    };
  });
}

async function renderAuth() {
  show("authBox", true);
  show("checkoutBox", false);
  show("libraryBox", false);
  setLogoutVisible(false);

  setErr("authErr", null);

  const mount = $("clerkMount");
  mount.innerHTML = "";

  try {
    const Clerk = await loadClerk();

    // Signed in?
    if (Clerk.user) {
      // Decide where user should go
      const me = await api("/api/me").catch(() => null);
      if (me?.hasPaid) return renderLibrary();
      return renderCheckout();
    }

    // Not signed in -> show Clerk UI
    Clerk.mountSignIn(mount, {
      appearance: { elements: {} },
      routing: "path",
      path: "/app",
      signUpUrl: "/app",
    });
  } catch (e) {
    // This is what you currently see when js.clerk.com can't be resolved.
    setErr(
      "authErr",
      "Inloggningen kunde inte laddas (Clerk script). Prova att ladda om sidan, eller testa ett annat nätverk. Om det bara händer för dig men inte andra, är det oftast DNS på din dator/router."
    );
  }
}

/* ---------------- Logout button ---------------- */

$("logoutBtn").onclick = async () => {
  try {
    if (window.Clerk?.signOut) await window.Clerk.signOut();
  } finally {
    window.location.href = "/app";
  }
};

/* ---------------- Start ---------------- */

(async function main() {
  try {
    await renderAuth();
  } catch (e) {
    console.error(e);
    setErr("authErr", e.message);
  }
})();
