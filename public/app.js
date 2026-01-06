const authBox = document.getElementById("authBox");
const appBox = document.getElementById("appBox");
const logoutBtn = document.getElementById("logoutBtn");
const authError = document.getElementById("authError");

async function loadClerk() {
  try {
    // 1. Fetch publishable key from backend
    const res = await fetch("/api/config");
    const { clerkPublishableKey } = await res.json();

    if (!clerkPublishableKey) {
      throw new Error("Missing clerkPublishableKey from /api/config");
    }

    // 2. Load Clerk
    await window.Clerk.load({
      publishableKey: clerkPublishableKey,
    });

    // 3. React to auth state
    window.Clerk.addListener(({ user }) => {
      if (user) {
        onSignedIn(user);
      } else {
        onSignedOut();
      }
    });

    // 4. Initial render
    if (window.Clerk.user) {
      onSignedIn(window.Clerk.user);
    } else {
      showSignIn();
    }

  } catch (err) {
    console.error(err);
    authError.textContent = "Authentication failed to load.";
  }
}

function showSignIn() {
  authBox.style.display = "block";
  appBox.style.display = "none";
  logoutBtn.style.display = "none";

  window.Clerk.mountSignIn(document.getElementById("clerkMount"), {
    redirectUrl: "/app",
  });
}

function onSignedIn(user) {
  authBox.style.display = "none";
  appBox.style.display = "block";
  logoutBtn.style.display = "inline-block";

  document.getElementById("appContent").innerHTML = `
    <p><strong>${user.primaryEmailAddress.emailAddress}</strong></p>
  `;
}

function onSignedOut() {
  showSignIn();
}

logoutBtn.onclick = async () => {
  await window.Clerk.signOut();
  window.location.href = "/";
};

// Start
loadClerk();
