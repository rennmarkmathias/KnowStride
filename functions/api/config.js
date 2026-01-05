export async function onRequestGet({ env }) {
  // Frontend behöver den publika Clerk-nyckeln för att kunna mounta UI:t.
  // (Den här är OK att exponera.)
  return json({
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY || "",
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
