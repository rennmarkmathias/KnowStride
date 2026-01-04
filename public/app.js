function getPlanFromUrl() {
  const u = new URL(window.location.href);
  // Viktigt: INGEN default här. Om inget plan valts ska det vara null.
  return u.searchParams.get("plan"); // null om saknas
}

function planLabel(plan) {
  const map = {
    monthly: "Monthly ($2.99)",
    yearly: "Yearly ($19.99)",
    "3y": "3 Years ($29.99)",
    "6y": "6 Years ($39.99)",
    "9y": "9 Years ($49.99)",
  };
  return map[plan] || plan;
}

async function api(path, method = "GET", body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const txt = await res.text();
  let data = null;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

const plan = getPlanFromUrl(); // null om ingen ?plan=
const selectedPlanLabelEl = document.getElementById("selectedPlanLabel");

// Visa plantext bara om plan finns
if (plan) {
  selectedPlanLabelEl.textContent = planLabel(plan);
} else {
  selectedPlanLabelEl.textContent = ""; // eller "No plan selected"
}

// Centralt: en funktion som bestämmer vad vi ska visa
async function showCorrectViewAfterAuth() {
  // Om man har valt plan: visa checkout
  if (plan) {
    document.getElementById("authBox").style.display = "none";
    document.getElementById("checkoutBox").style.display = "block";
    document.getElementById("libraryBox").style.display = "none";
    document.getElementById("logoutBtn").style.display = "inline-block";
    return;
  }

  // Om inget plan valts: visa bibliotek
  document.getElementById("authBox").style.display = "none";
  document.getElementById("checkoutBox").style.display = "none";
  document.getElementById("logoutBtn").style.display = "inline-block";
  await loadLibrary();
}

async function refreshMe() {
  try {
    const me = await api("/api/me");
    if (me?.loggedIn) {
      // Inloggad: visa rätt vy beroende på om plan finns eller inte
      await showCorrectViewAfterAuth();
      return true;
    }
  } catch {}

  // Inte inloggad: visa auth, göm resten
  document.getElementById("authBox").style.display = "block";
  document.getElementById("checkoutBox").style.display = "none";
  document.getElementById("libraryBox").style.display = "none";
  document.getElementById("logoutBtn").style.display = "none";
  return false;
}

async function loadLibrary() {
  const data = await api("/api/library");

  document.getElementById("libraryBox").style.display = "block";
  document.getElementById("checkoutBox").style.display = "none";

  const meta = `Unlocked: ${data.unlockedCount} of ${data.totalBlocksAvailable} • Retention: ${data.retention}`;
  document.getElementById("libraryMeta").textContent = meta;

  const list = document.getElementById("blocksList");
  list.innerHTML = "";

  // Om inget upplåst: visa hjälprad istället för tom lista
  if (!data.blocks || data.blocks.length === 0) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Your library is empty. Choose a plan to unlock Block 1.";
    list.appendChild(p);
    return;
  }

  data.blocks.forEach(b => {
    const btn = document.createElement("button");
    btn.className = "blockbtn";
    btn.textContent = `Block ${b.number}`;
    btn.addEventListener("click", async () => {
      const out = await api(`/api/library?block=${b.number}`);
      document.getElementById("reader").innerHTML = out.html;
      window.scrollTo({ top: document.getElementById("reader").offsetTop - 20, behavior: "smooth" });
    });
    list.appendChild(btn);
  });
}

document.getElementById("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const email = fd.get("email");
  const password = fd.get("password");
  const msg = document.getElementById("authMsg");
  msg.textContent = "Creating account...";

  try {
    await api("/api/signup", "POST", { email, password });
    msg.textContent = "Account created. Proceeding…";
    await refreshMe(); // kommer nu visa checkout om plan finns annars library
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const email = fd.get("email");
  const password = fd.get("password");
  const msg = document.getElementById("authMsg");
  msg.textContent = "Logging in...";

  try {
    await api("/api/login", "POST", { email, password });
    msg.textContent = "Logged in. Proceeding…";
    await refreshMe(); // kommer nu visa checkout om plan finns annars library
  } catch (err) {
    msg.textContent = err.message;
  }
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", "POST");
  window.location.href = "/";
});

document.getElementById("checkoutBtn").addEventListener("click", async () => {
  const msg = document.getElementById("checkoutMsg");

  // Skydd: om någon lyckas komma hit utan plan
  if (!plan) {
    msg.textContent = "No plan selected. Go back and choose a plan.";
    return;
  }

  msg.textContent = "Creating Stripe checkout…";
  try {
    const out = await api("/api/create-checkout-session", "POST", { plan });
    window.location.href = out.url;
  } catch (err) {
    msg.textContent = err.message;
  }
});

(async () => {
  await refreshMe();
})();
