// functions/api/_prodigi.js

export function prodigiSkuFor(env, { paper, size }) {
  const rawP = String(paper || "").trim().toLowerCase();
  const rawS = String(size || "").trim().toLowerCase().replace(/\s+/g, "");

  const p =
    rawP === "standard" || rawP === "blp" ? "blp" :
    rawP === "fine_art" || rawP === "fineart" || rawP === "fine art" || rawP === "fap" ? "fap" :
    rawP;

  const s = rawS === "a2a" ? "a2" : rawS;

  const key = `PRODIGI_SKU_${p.toUpperCase()}_${s.toUpperCase().replace(/[^A-Z0-9]/g, "")}`;
  const sku = env[key];

  if (!sku) {
    throw new Error(`Missing Prodigi SKU env var for paper=${p} size=${s}. Expected env var: ${key}`);
  }
  return sku;
}

export async function prodigiCreateOrder(env, payload) {
  const apiKey = env.PRODIGI_API_KEY;
  if (!apiKey) throw new Error("Missing PRODIGI_API_KEY env var");

  const res = await fetch("https://api.prodigi.com/v4.0/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) {
    throw new Error(`Prodigi create order failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}
