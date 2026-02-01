const DEFAULT_LIVE_BASE = "https://api.prodigi.com/v4.0";
const DEFAULT_SANDBOX_BASE = "https://api.sandbox.prodigi.com/v4.0";

function getBaseUrl(env) {
  if (env.PRODIGI_BASE_URL) return String(env.PRODIGI_BASE_URL).replace(/\/$/, "");
  const e = String(env.PRODIGI_ENV || "live").toLowerCase();
  return e === "sandbox" ? DEFAULT_SANDBOX_BASE : DEFAULT_LIVE_BASE;
}

export function prodigiSkuFor(env, paper, size) {
  const p = String(paper || "").toLowerCase();
  const s = String(size || "").toLowerCase();

  const key = (p === "fineart" ? "FAP" : "BLP");
  const sizeKey = s.replace(/[^a-z0-9]/gi, "").toUpperCase(); // a3 -> A3, 12x18 -> 12X18
  const envVar = `PRODIGI_SKU_${key}_${sizeKey}`;
  const sku = env[envVar];
  if (sku) return String(sku);

  // Safe defaults only where we can be confident.
  if (key === "BLP" && sizeKey === "18X24") return "GLOBAL-BLP-18X24";
  return null;
}

export async function createProdigiOrder(env, payload) {
  if (!env.PRODIGI_API_KEY) {
    throw new Error("Missing PRODIGI_API_KEY env var");
  }

  const base = getBaseUrl(env);
  const res = await fetch(`${base}/Orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": env.PRODIGI_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.outcome === "Failure") {
    const msg = data?.error?.message || data?.message || `Prodigi order failed (${res.status})`;
    const detail = data?.error?.details || data?.details;
    const suffix = detail ? `: ${JSON.stringify(detail).slice(0, 500)}` : "";
    throw new Error(`${msg}${suffix}`);
  }
  return data;
}
