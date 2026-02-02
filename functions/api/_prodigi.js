// functions/api/_prodigi.js

export function prodigiSkuFor(env, { paper, size }) {
  // paper: "blp" (Budget/Standard) eller "fap" (Fine Art)
  // size: "12x18" | "18x24" | "a2" | "a3"
  const p = String(paper || "").toLowerCase();
  const s = String(size || "").toLowerCase();

  const key =
    p === "blp"
      ? s === "12x18" ? "PRODIGI_SKU_BLP_12X18"
      : s === "18x24" ? "PRODIGI_SKU_BLP_18X24"
      : null
    : p === "fap"
      ? s === "12x18" ? "PRODIGI_SKU_FAP_12X18"
      : s === "18x24" ? "PRODIGI_SKU_FAP_18X24"
      : s === "a2" ? "PRODIGI_SKU_FAP_A2"
      : s === "a3" ? "PRODIGI_SKU_FAP_A3"
      : null
    : null;

  if (!key || !env[key]) {
    throw new Error(`Missing Prodigi SKU env var for paper=${paper} size=${size} (expected ${key})`);
  }
  return env[key];
}

export async function prodigiCreateOrder(env, payload) {
  const apiKey = env.PRODIGI_API_KEY;
  if (!apiKey) throw new Error("Missing PRODIGI_API_KEY");

  const res = await fetch("https://api.prodigi.com/v4.0/Orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();

  if (!res.ok) {
    // Viktigt: bubbla upp Prodigi-svaret så vi ser exakt varför det failar i Stripe webhook deliveries
    throw new Error(`Prodigi create order failed (${res.status}): ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
