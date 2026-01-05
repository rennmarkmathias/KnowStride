function planLabel(plan) {
  const map = {
    monthly: "Monthly ($2.99)",
    yearly: "Yearly ($14.99)",
    "3y": "3 Years ($24.99)",
    "6y": "6 Years ($39.99)",
    "9y": "9 Years ($49.99)",
  };
  return map[plan] || plan;
}

function getParams() {
  const u = new URL(window.location.href);
  return {
    plan: u.searchParams.get("plan"),
    success: u.searchParams.get("success") === "1",
    canceled: u.searchParams.get("canceled") === "1",
  };
}

function replaceUrlWithoutParams(keys) {
  const u = new URL(window.location.href);
  keys.forEach(k => u.searchParams.delete(k));
  window.history.replaceState({}, "", u.toString());
}

let clerkToken = null;

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
  const txt = await res.text();
  let data;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- Clerk loader ---------------- */

async function loadClerk() {
  const cfg = await fetch("/api/config").then(r => r.json());
  const pk = cfg?.clerkPublishableKey;
  if (!pk) throw new Error("Missing CLERK_PUBLISHABLE_KEY on server.");

  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.async = true;
    s.src = "https://js.clerk.com/v4/clerk.browser.js";
    s.setAttribute("data-clerk-publishable-key", pk);
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load Clerk script."));
    document.head.appendChild(s);
  });

  await window.Clerk.load();
  return window.Clerk;
}

/* ---------------- UI helpers ---------------- */

function show(id, on) {
  document.getElementById(id).style.display = on ? "block" : "none";
}

function setLogoutVisible(on) {
  document.getElementById("logoutBtn").style.display = on ? "inline-block" : "none";
}

async function renderLibrary() {
  show("authBox", false);
  show("checkoutBox", false);
  show("libraryBox", true);
  setLogoutVisible(true);

  const meta = document.getElementById("libraryMeta");
  const list = document.getElementById("blocksList");
  const reader = document.getElementById("reader");

  meta.textContent = "Loading…";
  list.innerHTML = "";
  reader.innerHTML = "";

  const lib = await api("/api/library");

  if (!lib.hasPaid) {
    meta.textContent = "Your library is empty. Choose a plan to unlock Block 1.";
    return;
  }

  meta.textContent = `Unlocked: ${lib.blocks.length} • Retention: ${lib.retention} • Access until: ${new Date(lib.accessUntil).toLocaleString()}`;

  lib.blocks.forEach(b => {
    const btn = document.createElement("button");
    btn.className = "blockBtn";
    btn.textContent = `Block ${b.number}`;
    btn.addEventListener("click", async () => {
      const data = await api(`/api/library?block=${b.number}`);
      reader.innerHTML = data.html;
      reader.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    list.appendChild(btn);
  });
}

async function renderCheckout(plan) {
  show("authBox", false);
  show("checkoutBox", true);
  show("libraryBox", false);
  setLogoutVisible(true);

  document.getElementById("selectedPlanLabel").textContent = planLabel(plan);

  const msg = document.getElementById("checkoutMsg");
  msg.textContent = "";

  document.getElementById("checkoutBtn").onclick = async () => {
    try {
      msg.textContent = "Opening Stripe…";
      const r = await api("/api/create-checkout-session", "POST", { plan });
      window.location.href = r.url;
    } catch (e) {
      msg.textContent = e.message;
    }
  };
}

async function ensureToken(Clerk) {
  if (!Clerk.session) return null;
  clerkToken = await Clerk.session.getToken();
  return clerkToken;
}

async function pollUntilAccess(maxMs = 30000) {
  const start = Date.now();
  const meta = document.getElementById("libraryMeta");

  while (Date.now() - start < maxMs) {
    const lib = await api("/api/library");
    if (lib.hasPaid) return true;
    meta.textContent = "Thanks! Activating your access… (this can take a few seconds)";
    await new Promise(r => setTimeout(r, 2000));
  }
  meta.textContent = "Payment received, but access is still pending. Please refresh in a minute or contact support.";
  return false;
}

/* ---------------- Boot ---------------- */

(async function main() {
  const authMsg = document.getElementById("authMsg");
  const { plan, success, canceled } = getParams();

  const Clerk = await loadClerk();

  document.getElementById("logoutBtn").addEventListener("click", async () => {
    await Clerk.signOut();
    clerkToken = null;
    window.location.href = "/app.html";
  });

  if (!Clerk.user) {
    // Not signed in => show Clerk sign-in
    show("authBox", true);
    show("checkoutBox", false);
    show("libraryBox", false);
    setLogoutVisible(false);

    authMsg.textContent = "";

    Clerk.mountSignIn(document.getElementById("clerkMount"), {
      // Efter inlogg: tillbaka hit (behåll plan-param om du kom från pricing)
      redirectUrl: plan ? `/app.html?plan=${encodeURIComponent(plan)}` : "/app.html",
      signUpUrl: plan ? `/app.html?plan=${encodeURIComponent(plan)}#signup` : "/app.html#signup",
    });

    return;
  }

  // Signed in => get token
  await ensureToken(Clerk);

  // Success: gå direkt till library + poll tills webhooken satt access
  if (success) {
    // städa URL så det inte ser konstigt ut
    replaceUrlWithoutParams(["success", "plan"]);
    await renderLibrary();
    await pollUntilAccess();
    await renderLibrary();
    return;
  }

  // Cancel: visa checkout igen om plan fanns
  if (canceled && plan) {
    // ta bort canceled-flaggan så sidan känns normal
    replaceUrlWithoutParams(["canceled"]);
    await renderCheckout(plan);
    return;
  }

  // Normal: plan => checkout, annars => library
  if (plan) {
    await renderCheckout(plan);
  } else {
    await renderLibrary();
  }
})();
