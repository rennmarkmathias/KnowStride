// public/js/confirm-checkout.js

(async () => {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session_id");

  if (!sessionId) return;

  try {
    const res = await fetch("/api/confirm-checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ sessionId })
    });

    if (!res.ok) {
      console.error("Checkout confirmation failed");
      return;
    }

    // Viktigt: tvinga omladdning av library-state
    window.location.href = "/app?checkout=success";
  } catch (err) {
    console.error("Confirm checkout error", err);
  }
})();
