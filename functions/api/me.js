import { requireClerkAuth } from "./_auth";

export async function onRequestGet({ request, env }) {
  const auth = await requireClerkAuth(request, env);
  if (!auth) return json({ loggedIn: false }, 200);

  return json({ loggedIn: true, userId: auth.userId }, 200);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
