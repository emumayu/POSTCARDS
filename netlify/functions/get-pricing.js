// netlify/functions/get-pricing.js
//
// Prices shown on the site, per region (jp = JPY, Japanese site / intl = USD, English site):
//   full    : FULL PLAN amount per number of days (from lib/pricing.js, same table checkout bills from)
//   day     : 1 DAY PLAN amount  } read from Stripe, using the same Price IDs (Netlify env)
//   list    : FULL LIST amount   } that create-checkout-session.js bills with
//   regular : display-only "Regular" price (Japanese site, 1 DAY only)
// `currency` / `full` at the top level are the JPY table (kept for older pages).
// Amounts are in major units (yen / dollars).

const Stripe = require("stripe");
const { FULL_PLAN, amountsOf, SIMPLE_PRICE_ENV, CURRENCY, DISPLAY_REGULAR, majorUnits } = require("./lib/pricing");

let cache = null; // { at, data } — per warm function instance
const TTL = 5 * 60 * 1000;

async function simplePrices() {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  const out = { jp: {}, intl: {} };
  if (!process.env.STRIPE_SECRET_KEY) return out;
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-03-31.basil" });
  const jobs = [];
  for (const region of Object.keys(SIMPLE_PRICE_ENV)) {
    for (const plan of Object.keys(SIMPLE_PRICE_ENV[region])) {
      const id = process.env[SIMPLE_PRICE_ENV[region][plan]];
      if (!id) continue;
      jobs.push(
        stripe.prices.retrieve(id).then((pr) => {
          if (pr && pr.active !== false && pr.currency === CURRENCY[region] && Number.isInteger(pr.unit_amount)) {
            out[region][plan] = majorUnits(pr.currency, pr.unit_amount);
          } else {
            console.error("get-pricing: unexpected Price", { region, plan, id, currency: pr && pr.currency });
          }
        }).catch((err) => console.error("get-pricing: Price lookup failed", { region, plan, id, message: err.message }))
      );
    }
  }
  await Promise.all(jobs);
  cache = { at: Date.now(), data: out };
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  const simple = await simplePrices();
  const regions = {};
  for (const r of Object.keys(FULL_PLAN)) {
    regions[r] = {
      currency: FULL_PLAN[r].currency,
      full: amountsOf(r),
      day: simple[r].day != null ? simple[r].day : null,
      list: simple[r].list != null ? simple[r].list : null,
      regular: DISPLAY_REGULAR[r] || null,
    };
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ currency: regions.jp.currency, full: regions.jp.full, regions }),
  };
};
