let clerkToken = null;

/* ---------------- utils ---------------- */

function show(id, on) {
  document.getElementById(id).style.display = on ? "block" : "none";
}

function setLogoutVisible(on) {
  document.getElementById("logoutBtn").style.display = on
    ? "inline-block"
    : "none";
}

async function api(path, method = "GET", body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  if (clerkToken) {
    opts.headers["Authorization"] = `Bearer ${clerkToken}`;
  }

  const res = await fetch(path, opts);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

/* ---------------- Clerk loader ---------------- */

async function loadClerk() {
  const cfg = await fetch("/api/config").then(r => r.json());

  if (!cfg?.clerkPublishableKey) {
    throw new Error(
      "Missing clerkPublishableKey from /api/config"
    );
  }

  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://js.clerk.com/v4/clerk.browser.js";
    s.async = true;
    s.setAttribute(
      "data-clerk-publishable-key",
      cfg.clerkPublishableKey
    );
    s.onload = resolve;
    s.onerror = () =>
      reject(new Error("Failed to load Clerk script"));
    document.head.appendChild(s);
  });

  await window.Clerk.load();
  return window.Clerk;
}

/* ---------------- main ---------------- */

(async function main() {
  const authMsg = document.getElementById("authMsg");

  let Clerk;
  try {
    Clerk = await loadClerk();
  } catch (e) {
    authMsg.textContent = e.message;
    return;
  }

  document
    .getElementById("logoutBtn")
    .addEventListener("click", async () => {
      await Clerk.signOut();
      clerkToken = null;
      window.location.href = "/app.html";
    });

  if (!Clerk.user) {
    // NOT SIGNED IN
    show("authBox", true);
    show("checkoutBox", false);
    show("libraryBox", false);
    setLogoutVisible(false);

    Clerk.mountSignIn(
      document.getElementById("clerkMount"),
      {
        redirectUrl: "/app.html",
        signUpUrl: "/app.html#signup",
      }
    );

    return;
  }

  // SIGNED IN
  clerkToken = await Clerk.session.getToken();

  show("authBox", false);
  show("checkoutBox", false);
  show("libraryBox", true);
  setLogoutVisible(true);

  const meta = document.getElementById("libraryMeta");
  meta.textContent = "Loading library…";

  const lib = await api("/api/library");

  if (!lib.hasPaid) {
    meta.textContent =
      "Choose a plan to unlock your first block.";
    return;
  }

  meta.textContent = `Unlocked ${lib.blocks.length} blocks`;
})();
