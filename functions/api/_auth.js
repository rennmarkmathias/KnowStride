export async function requireClerkAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;

  const token = auth.slice("Bearer ".length).trim();
  if (!token) return null;

  // Verifiera session-token via Clerk Backend API
  const verify = await fetch("https://api.clerk.com/v1/sessions/verify", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token }),
  });

  if (!verify.ok) return null;

  const v = await verify.json();
  const userId = v?.session?.user_id;
  if (!userId) return null;

  return { userId };
}
