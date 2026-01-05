export async function onRequestPost() {
  return new Response(JSON.stringify({ error: "Use Clerk sign-in." }), {
    status: 410,
    headers: { "Content-Type": "application/json" },
  });
}
