// netlify/functions/lib/pricing.js
//
// FULL PLAN: one Stripe Price per number of days, for each region.
//   jp   -> JPY Prices (Japanese version of the site)
//   intl -> USD Prices (English version of the site)
//
// The website reads the amounts from here (through /.netlify/functions/get-pricing) and
// create-checkout-session.js bills with the Price ID listed here, after checking with
// Stripe that this Price really has the amount and currency written below.
// So what the buyer sees, what is in this file and what Stripe charges always agree;
// if they ever don't (for example a Price was edited in Stripe), checkout stops with an error.
//
// Price IDs are NOT fixed here: they come from Netlify environment variables, one per region and
// number of days (so test mode and live mode can use their own Prices):
//   STRIPE_PRICE_JP_FULL_2 ... STRIPE_PRICE_JP_FULL_7      (JPY)
//   STRIPE_PRICE_INTL_FULL_2 ... STRIPE_PRICE_INTL_FULL_7  (USD)
// Only while STRIPE_SECRET_KEY is a TEST key (sk_test_ / rk_test_) and a variable is not set,
// the test-mode Price ID listed below is used, so development keeps working unchanged.
// With a live key every variable must be set (a missing one stops checkout with a clear error).
// The amounts below stay in code: checkout checks that each Price in Stripe matches its amount.
//
// To change a price: create the new Price in Stripe, set its id in the variable, and update the amount here.
//
// 1 DAY PLAN and FULL LIST are NOT in this file. They keep using the Price IDs stored in the
// Netlify environment variables (STRIPE_PRICE_JP_DAY / _JP_LIST / _INTL_DAY / _INTL_LIST).
//
// "+ tax" on the site is display wording only: Stripe charges exactly the Price amount.
const FULL_PLAN_DEF = {
  jp: {
    currency: "jpy", // JPY has no minor unit: unit_amount 4000 = ¥4,000
    days: {
      2: { id: "price_1UHPVIHAahrVQqhztkRSLWmj", amount: 4000 },
      3: { id: "price_1UMgMlHAahrVQqhzCwmtO2C2", amount: 5500 },
      4: { id: "price_1UMgNVHAahrVQqhzI4NbciNc", amount: 6500 },
      5: { id: "price_1UMgNlHAahrVQqhzfKkuv0Mk", amount: 7500 },
      6: { id: "price_1UMgNzHAahrVQqhz3M1B1xtR", amount: 8500 },
      7: { id: "price_1UMgOKHAahrVQqhzGOggwxyR", amount: 9500 },
    },
  },
  intl: {
    currency: "usd", // USD amounts are in dollars here; Stripe stores cents (26 -> 2600)
    days: {
      2: { id: "price_1UHvHsHAahrVQqhz9cjvG4CN", amount: 26 },
      3: { id: "price_1UMgRaHAahrVQqhzFa3YrRJO", amount: 34 },
      4: { id: "price_1UMgRqHAahrVQqhzqEs1zFF9", amount: 42 },
      5: { id: "price_1UMgS6HAahrVQqhzvB9iBz9L", amount: 50 },
      6: { id: "price_1UMgSSHAahrVQqhzEap37wy5", amount: 58 },
      7: { id: "price_1UMgSqHAahrVQqhzVgfCyWpd", amount: 66 },
    },
  },
};

// Test-mode fallback only (see the header). Live mode never uses these.
const isTestKey = () => /^(sk|rk)_test_/.test(process.env.STRIPE_SECRET_KEY || "");
const fullPriceEnvName = (region, days) => `STRIPE_PRICE_${region === "intl" ? "INTL" : "JP"}_FULL_${days}`;

// FULL_PLAN[region].days[n] = { id, amount }; `id` is looked up when read, never stored.
const FULL_PLAN = {};
for (const region of Object.keys(FULL_PLAN_DEF)) {
  FULL_PLAN[region] = { currency: FULL_PLAN_DEF[region].currency, days: {} };
  for (const [d, v] of Object.entries(FULL_PLAN_DEF[region].days)) {
    FULL_PLAN[region].days[d] = {
      amount: v.amount,
      envName: fullPriceEnvName(region, d),
      get id() {
        const fromEnv = (process.env[this.envName] || "").trim();
        return fromEnv || (isTestKey() ? v.id : undefined);
      },
    };
  }
}

const regionOf = (v) => (v === "intl" ? "intl" : "jp");
const minorUnits = (currency, amount) => (currency === "jpy" ? amount : Math.round(amount * 100));
const amountsOf = (region) =>
  Object.fromEntries(Object.entries(FULL_PLAN[region].days).map(([d, v]) => [d, v.amount]));

// ---------------------------------------------------------------------------
// 1 DAY PLAN and FULL LIST: Price IDs come from the Netlify environment variables
// (the same ones create-checkout-session.js bills with). Their amounts are read from
// Stripe itself (see get-pricing.js), so the site never shows a price Stripe doesn't charge.
const SIMPLE_PRICE_ENV = {
  jp: { day: "STRIPE_PRICE_JP_DAY", list: "STRIPE_PRICE_JP_LIST" },
  intl: { day: "STRIPE_PRICE_INTL_DAY", list: "STRIPE_PRICE_INTL_LIST" },
};
const CURRENCY = { jp: "jpy", intl: "usd" };

// Display only: the struck-through "Regular" price next to the 1 DAY early launch price.
// Japanese site only (the English site shows the sale price alone).
const DISPLAY_REGULAR = { jp: { day: 2700 } };

// The Price a paid Checkout Session must contain for this plan / region / days.
//   -> { id, currency, amount }   amount is null for day / list (checked against Stripe itself)
//   -> null when the combination is not sold
function expectedPrice(plan, region, days) {
  const r = regionOf(region);
  if (plan === "full") {
    const e = FULL_PLAN[r].days[days];
    return e && e.id ? { id: e.id, currency: FULL_PLAN[r].currency, amount: e.amount } : null;
  }
  const env = SIMPLE_PRICE_ENV[r][plan];
  const id = env && process.env[env];
  return id ? { id, currency: CURRENCY[r], amount: null } : null;
}

const majorUnits = (currency, minor) => (currency === "jpy" ? minor : minor / 100);

module.exports = {
  FULL_PLAN, regionOf, minorUnits, majorUnits, amountsOf,
  SIMPLE_PRICE_ENV, CURRENCY, DISPLAY_REGULAR, expectedPrice,
};
