import Stripe from "stripe";
import { requireClerkAuth } from "./_auth";
import { findPosterById, buildPrintUrl, json } from "./_posters";

// Guest checkout is allowed. If the user is signed in, we attach their Clerk user id.
async function getOptionalClerkUserId(request, env) {
  try {
    const auth = await requireClerkAuth(request, env);
    return auth?.userId || null;
  } catch {
    return null;
  }
}

const ALLOWED_PAPERS = new Set(["standard", "fineart"]);
const ALLOWED_SIZES = new Set(["a3", "a2", "12x18", "18x24"]);

export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    if (!env.STRIPE_SECRET_KEY) {
      return new Response("Missing STRIPE_SECRET_KEY", { status: 500 });
    }

    const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2024-06-20" });

    const body = await request.json();
    const posterId = String(body?.posterId || "").trim();
    const size = String(body?.size || "").toLowerCase();
    const paper = String(body?.paper || "").toLowerCase();
    const mode = String(body?.mode || "STRICT").toUpperCase();
    const quantity = Math.min(Math.max(Number(body?.quantity || 1), 1), 10);

    if (!posterId) return json({ error: "posterId is required" }, 400);
    if (!ALLOWED_SIZES.has(size)) return json({ error: `invalid size: ${size}` }, 400);
    if (!ALLOWED_PAPERS.has(paper)) return json({ error: `invalid paper: ${paper}` }, 400);

    const poster = await findPosterById(request, env, posterId);
    if (!poster) return json({ error: "poster not found" }, 404);

    // Price lookup (USD). Stored in posters.json for now.
    const price = Number(poster?.prices?.[paper]?.[size]);
    if (!Number.isFinite(price) || price <= 0) {
      return json({ error: "missing price for variant" }, 400);
    }

    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;

    const printUrl = buildPrintUrl(origin, poster, size, mode);

    const clerkUserId = await getOptionalClerkUserId(request, env);

    const successUrl = `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/p.html?id=${encodeURIComponent(posterId)}`;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${poster.title} — ${paper === "fineart" ? "Fine Art" : "Standard"} (${size.toUpperCase()})`,
            },
            unit_amount: Math.round(price * 100),
          },
          quantity,
        },
      ],
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      shipping_address_collection: {
        allowed_countries: [
          "US",
          "CA",
          "GB",
          "IE",
          "SE",
          "NO",
          "DK",
          "FI",
          "DE",
          "FR",
          "NL",
          "BE",
          "ES",
          "IT",
          "AT",
          "CH",
          "PL",
          "PT",
          "AU",
          "NZ",
        ],
      },
      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: { amount: 0, currency: "usd" },
            display_name: "Shipping included",
            delivery_estimate: {
              minimum: { unit: "business_day", value: 3 },
              maximum: { unit: "business_day", value: 10 },
            },
          },
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        kind: "poster",
        poster_id: posterId,
        poster_title: poster.title,
        size,
        paper,
        mode: mode === "ART" ? "ART" : "STRICT",
        print_url: printUrl,
        ...(clerkUserId ? { clerk_user_id: clerkUserId } : {}),
      },
    });

    return json({ url: session.url });
  } catch (err) {
    return json({ error: err?.message || String(err) }, 500);
  }
}
