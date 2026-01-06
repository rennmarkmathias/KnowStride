const $ = (id) => document.getElementById(id);

const authBox = $("authBox");
const appBox = $("appBox");
const authStatus = $("authStatus");
const authError = $("authError");
const appContent = $("appContent");
const logoutBtn = $("logoutBtn");

function showLogin() {
  authBox.style.display = "";
  appBox.style.display = "none";
  logoutBtn.style.display = "none";
}

function showApp(user) {
  authBox.style.display = "none";
  appBox.style.display = "";
  logoutBtn.style.display = "";

  const email =
    user.primaryEmailAddress?.emailAddress ||
    user.emailAddresses?.[0]?.emailAddress ||
    "Unknown";

  appContent.innerHTML = `
    <p class="muted">Logged in as <strong>${email}</strong></p>
    <p style="margin-top:12px;">✅ Authentication works.</p>
  `;
}

async function fetchConfig() {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Failed to load /api/config");
  return res.json();
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve(src);
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function loadClerk() {
  const urls = [
    "https://js.clerk.com/clerk.browser.js",
    "https://unpkg.com/@clerk/clerk-js@latest/dist/clerk.browser.js"
  ];

  for (const url of urls) {
    try {
      await loadScript(url);
      if (window.Clerk) return;
    } catch {}
  }

  throw new Error("Clerk script could not be loaded (CDN blocked)");
}

async function main() {
  try {
    authStatus.textContent = "Loading configuration…";
    const { clerkPublishableKey } = await fetchConfig();

    if (!clerkPublishableKey?.startsWith("pk_")) {
      throw new Error("Invalid Clerk publishable key");
    }

    authStatus.textContent = "Loading authentication…";
    await loadClerk();

    await window.Clerk.load({ publishableKey: clerkPublishableKey });

    window.Clerk.mountSignIn($("#clerkMount"), {
      afterSignInUrl: "/app",
      afterSignUpUrl: "/app"
    });

    logoutBtn.onclick = async () => {
      await window.Clerk.signOut();
      location.href = "/app";
    };

    window.Clerk.addListener(({ user }) => {
      if (user) showApp(user);
      else showLogin();
    });

    if (window.Clerk.user) {
      showApp(window.Clerk.user);
    } else {
      showLogin();
      authStatus.textContent = "Not logged in.";
    }
  } catch (err) {
    console.error(err);
    authStatus.textContent = "";
    authError.textContent = err.message;
  }
}

main();
