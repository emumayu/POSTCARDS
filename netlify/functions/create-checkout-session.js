// netlify/functions/create-checkout-session.js
//
// Creates a Stripe Checkout Session and returns its URL to the browser.
// The browser never sees the Stripe secret key or any Price ID directly —
// both live only in Netlify's Environment Variables (server-side).
//
// Which Price ID is "current" for a plan (e.g. the ¥2,000 Early Launch price
// vs. the ¥2,700 Regular price) is decided entirely by which Price ID is
// stored in the matching environment variable below. To switch from Early
// to Regular later, update the STRIPE_PRICE_JP_DAY value in Netlify — no
// code change or redeploy of this function is required.

const Stripe = require("stripe");

// region -> plan -> env var name holding the Stripe Price ID
const PRICE_ENV = {
  jp: {
    day: "STRIPE_PRICE_JP_DAY",
    full: "STRIPE_PRICE_JP_FULL",
    list: "STRIPE_PRICE_JP_LIST",
  },
  intl: {
    day: "STRIPE_PRICE_INTL_DAY",
    full: "STRIPE_PRICE_INTL_FULL",
    list: "STRIPE_PRICE_INTL_LIST",
  },
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "STRIPE_SECRET_KEY is not configured." }),
    };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body." }) };
  }

  const plan = payload.plan; // "day" | "full" | "list"
  // No region-selector exists in the current UI yet, so this always resolves
  // to "jp" for now. See the accompanying note about International pricing.
  const region = payload.region === "intl" ? "intl" : "jp";

  if (!PRICE_ENV[region] || !PRICE_ENV[region][plan]) {
    return { statusCode: 400, body: JSON.stringify({ error: `Unknown plan "${plan}".` }) };
  }

  const envVarName = PRICE_ENV[region][plan];
  const priceId = process.env[envVarName];

  if (!priceId) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: `${envVarName} is not set in Netlify environment variables.` }),
    };
  }

  const origin = event.headers.origin || `https://${event.headers.host}`;

  const successParams = new URLSearchParams({ stripe: "success", plan, region });
  if (payload.city) successParams.set("city", payload.city);
  if (payload.wl) successParams.set("wl", payload.wl);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${origin}/?${successParams.toString()}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?stripe=cancel`,
      metadata: {
        plan,
        region,
        city: payload.city || "",
        wl: payload.wl || "",
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
