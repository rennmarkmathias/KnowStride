export async function onRequestPost() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": "ks_token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax",
    },
  });
}
