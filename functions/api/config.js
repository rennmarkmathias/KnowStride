export async function onRequestGet({ env }) {
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
