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
const { FULL_PLAN_PRICES, CURRENCY } = require("./lib/pricing");

// FULL PLAN is priced by number of days (see lib/pricing.js) and is charged with an
// inline price built from that table, so it does not use a Price ID.
// 1 DAY PLAN and FULL LIST keep using the Price IDs below.
//
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

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-03-31.basil" });

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

  let lineItems;
  let days = null;
  let amount = null;

  if (plan === "full") {
    // Price depends on the number of days. The amount comes from lib/pricing.js only.
    days = Number.parseInt(payload.days, 10);
    amount = FULL_PLAN_PRICES[days];
    if (!Number.isInteger(days) || !amount) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Unknown number of days "${payload.days}" for the Full Plan.` }),
      };
    }
    // The page sends the price it showed the buyer. If it doesn't match what we are about
    // to bill, stop instead of charging a different amount than the one on screen.
    if (payload.amount !== undefined && Number(payload.amount) !== amount) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: "The price for this plan has changed. Please reload the page and try again." }),
      };
    }
    lineItems = [
      {
        price_data: {
          currency: CURRENCY,
          unit_amount: amount,
          product_data: {
            name: `POSTCARDS Full Plan \u00b7 ${days} days`,
            description: payload.city ? `${payload.city} \u00b7 ${days}-day guide` : `${days}-day guide`,
          },
        },
        quantity: 1,
      },
    ];
  } else {
    const envVarName = PRICE_ENV[region][plan];
    const priceId = process.env[envVarName];

    if (!priceId) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `${envVarName} is not set in Netlify environment variables.` }),
      };
    }
    lineItems = [{ price: priceId, quantity: 1 }];
  }

  const origin = event.headers.origin || `https://${event.headers.host}`;

  const successParams = new URLSearchParams({ stripe: "success", plan, region });
  if (days) successParams.set("days", String(days));
  if (amount) successParams.set("amount", String(amount));
  if (payload.city) successParams.set("city", payload.city);
  if (payload.wl) successParams.set("wl", payload.wl);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      allow_promotion_codes: true,
      success_url: `${origin}/?${successParams.toString()}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?stripe=cancel`,
      metadata: {
        plan,
        region,
        city: payload.city || "",
        wl: payload.wl || "",
        days: days ? String(days) : "",
        amount: amount ? String(amount) : "",
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
