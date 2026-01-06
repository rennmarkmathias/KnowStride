async function initClerk() {
  // Vänta tills Clerk-scriptet faktiskt finns
  if (!window.Clerk) {
    document.getElementById("error").textContent =
      "Failed to load Clerk script";
    return;
  }

  // Hämta publishable key (den funkar redan hos dig)
  const res = await fetch("/api/config");
  const { clerkPublishableKey } = await res.json();

  await window.Clerk.load({
    publishableKey
  });

  // Rendera sign-in UI
  window.Clerk.mountSignIn("#clerk-root", {
    appearance: {
      elements: {
        card: "clerk-card"
      }
    }
  });
}

initClerk().catch(err => {
  console.error(err);
  document.getElementById("error").textContent =
    "Clerk failed to initialize";
});
