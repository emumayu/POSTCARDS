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
const { FULL_PLAN, regionOf, minorUnits } = require("./lib/pricing");
const { safeOrigin } = require("./lib/mail");

// FULL PLAN is priced by number of days: one Stripe Price per day count and region (JPY for "jp",
// USD for "intl"); the amounts are in lib/pricing.js and the Price IDs in STRIPE_PRICE_{JP|INTL}_FULL_<days>. 1 DAY PLAN and FULL LIST keep using the
// Price IDs stored in the environment variables below (unchanged).
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
  let currency = null;

  if (plan === "full") {
    // One Stripe Price per number of days (JPY for the Japanese site, USD for the English site).
    days = Number.parseInt(payload.days, 10);
    const table = FULL_PLAN[regionOf(region)];
    const entry = table.days[days];
    if (!Number.isInteger(days) || !entry) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Unknown number of days "${payload.days}" for the Full Plan.` }),
      };
    }
    if (!entry.id) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: `${entry.envName} is not set in Netlify environment variables.` }),
      };
    }
    amount = entry.amount;
    currency = table.currency;
    // The page sends the price it showed the buyer. If it doesn't match, stop instead of
    // charging a different amount than the one on screen.
    if (payload.amount !== undefined && Number(payload.amount) !== amount) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: "The price for this plan has changed. Please reload the page and try again." }),
      };
    }
    // Make sure the Stripe Price still is what we think it is (amount, currency, active).
    try {
      const pr = await stripe.prices.retrieve(entry.id);
      if (!pr || pr.active === false || pr.currency !== currency || pr.unit_amount !== minorUnits(currency, amount)) {
        console.error("FULL PLAN price mismatch", { id: entry.id, expected: { currency, amount }, stripe: pr && { currency: pr.currency, unit_amount: pr.unit_amount, active: pr.active } });
        return {
          statusCode: 500,
          body: JSON.stringify({ error: `The Stripe price for ${days} days (${entry.id}) doesn't match the price on the site. Please contact us.` }),
        };
      }
    } catch (err) {
      console.error("FULL PLAN price lookup failed:", err);
      return { statusCode: 500, body: JSON.stringify({ error: `Couldn't check the Stripe price for ${days} days: ${err.message}` }) };
    }
    lineItems = [{ price: entry.id, quantity: 1 }];
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
      // Always create a Stripe Customer (guest checkout, no login): lets us manage buyers in Stripe
      // and link them to public.customers by e-mail.
      customer_creation: "always",
      // Managed Payments (Stripe as the seller of record: it calculates, collects and files tax; +3.5% per sale).
      // Used for the English / international site, where foreign VAT / GST would otherwise fall on us.
      // The Japanese site is not charged through it (domestic tax is handled by us, and no extra fee).
      // Products used with it need an eligible tax code (see scripts/create-sandbox-prices.js).
      managed_payments: { enabled: region === "intl" },
      // Refund terms right above the pay button (last confirmation step; see the Legal Notice page on the site).
      // Stripe does not allow custom_text together with Managed Payments, so only the Japanese site (no Managed
      // Payments) gets it; on the English site the terms are on the plan pages and in the Legal Notice.
      ...(region === "intl" ? {} : {
        custom_text: {
          submit: {
            message: "デジタル商品のため、旅程の保存後は返金できません（保存前は購入から14日以内、当方の不具合の場合は30日以内であれば返金します）。詳しくは postcardsguide.com の「特定商取引法に基づく表記」をご確認ください。",
          },
        },
      }),
      success_url: `${origin}/?${successParams.toString()}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?stripe=cancel`,
      metadata: {
        plan,
        region,
        city: payload.city || "",
        wl: payload.wl || "",
        days: days ? String(days) : "",
        amount: amount ? String(amount) : "",
        currency: currency || "",
        // The site the buyer pays on: the confirmation e-mail links back to it (only this project's own hosts).
        origin: safeOrigin(origin) || "",
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
