// functions/api/_prodigi.js

const PRODIGI_API_BASE = "https://api.prodigi.com/v4.0";

/**
 * Mappar (paper, size) -> SKU via env vars du redan lagt in:
 *  - Budget/Standard:
 *    PRODIGI_SKU_BLP_12X18, PRODIGI_SKU_BLP_18X24
 *  - Fine art / Enhanced matte:
 *    PRODIGI_SKU_FAP_12X18, PRODIGI_SKU_FAP_18X24, PRODIGI_SKU_FAP_A2, PRODIGI_SKU_FAP_A3
 */
export function prodigiSkuFor(env, { paper, size }) {
  const p = (paper || "").toLowerCase();
  const s = (size || "").toLowerCase();

  // Normalisera size-nycklar
  const sizeKey =
    s === "12x18" || s === "12x18_in" || s === "12x18 in" ? "12X18" :
    s === "18x24" || s === "18x24_in" || s === "18x24 in" ? "18X24" :
    s === "a2" ? "A2" :
    s === "a3" ? "A3" :
    null;

  if (!sizeKey) throw new Error(`Unknown size for Prodigi SKU: "${size}"`);

  // Standard/Budget (BLP) – bara 12x18 och 18x24 enligt dina SKUs
  if (p === "standard" || p === "budget" || p === "blp") {
    if (sizeKey === "12X18") return env.PRODIGI_SKU_BLP_12X18;
    if (sizeKey === "18X24") return env.PRODIGI_SKU_BLP_18X24;
    throw new Error(`No Budget/Standard SKU for size "${sizeKey}"`);
  }

  // Fineart/Enhanced Matte (FAP)
  if (p === "fineart" || p === "fine_art" || p === "fap") {
    if (sizeKey === "12X18") return env.PRODIGI_SKU_FAP_12X18;
    if (sizeKey === "18X24") return env.PRODIGI_SKU_FAP_18X24;
    if (sizeKey === "A2") return env.PRODIGI_SKU_FAP_A2;
    if (sizeKey === "A3") return env.PRODIGI_SKU_FAP_A3;
    throw new Error(`No Fine Art SKU for size "${sizeKey}"`);
  }

  throw new Error(`Unknown paper "${paper}"`);
}

/**
 * Skapar Prodigi-order via API.
 * OBS: Prodigi kräver att du har payment details i Prodigi-kontot (vilket du nu har lagt in).
 */
export async function prodigiCreateOrder(env, payload) {
  if (!env.PRODIGI_API_KEY) throw new Error("Missing PRODIGI_API_KEY env var");

  const res = await fetch(`${PRODIGI_API_BASE}/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": env.PRODIGI_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) {
    throw new Error(`Prodigi API error ${res.status}: ${JSON.stringify(json)}`);
  }

  return json;
}
