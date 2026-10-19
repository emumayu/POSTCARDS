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
// Price IDs are NOT in this file: they come from Netlify environment variables, one per region and number of
// days, so test mode (sandbox) and live mode each use their own Prices:
//   STRIPE_PRICE_JP_FULL_2 ... STRIPE_PRICE_JP_FULL_7      (JPY)
//   STRIPE_PRICE_INTL_FULL_2 ... STRIPE_PRICE_INTL_FULL_7  (USD)
// A missing variable stops checkout with a clear error. The amounts below stay in code: checkout checks that
// each Price in Stripe matches its amount, so what the buyer sees, what is here and what Stripe charges agree.
//
// To change a price: create the new Price in Stripe, set its id in the variable, and update the amount here
// (and in scripts/*.js and index.html, which show / create the same amounts).
//
// Yen prices are tax-included: Stripe charges exactly the Price amount and the site says 税込.
// Dollar prices (English site) go through Managed Payments: the buyer's local tax is added at checkout.
const FULL_PLAN_DEF = {
  jp: {
    currency: "jpy", // JPY has no minor unit: unit_amount 4400 = ¥4,400. Yen prices are TAX-INCLUDED (総額表示).
    days: { 2: 4400, 3: 6100, 4: 7200, 5: 8300, 6: 9400, 7: 10500 },
  },
  intl: {
    currency: "usd", // USD amounts are in dollars here; Stripe stores cents (26 -> 2600). Tax is added at checkout (Managed Payments).
    days: { 2: 26, 3: 34, 4: 42, 5: 50, 6: 58, 7: 66 },
  },
};

const fullPriceEnvName = (region, days) => `STRIPE_PRICE_${region === "intl" ? "INTL" : "JP"}_FULL_${days}`;

// FULL_PLAN[region].days[n] = { id, amount }; `id` is looked up from the environment when read, never stored.
const FULL_PLAN = {};
for (const region of Object.keys(FULL_PLAN_DEF)) {
  FULL_PLAN[region] = { currency: FULL_PLAN_DEF[region].currency, days: {} };
  for (const [d, amount] of Object.entries(FULL_PLAN_DEF[region].days)) {
    FULL_PLAN[region].days[d] = {
      amount,
      envName: fullPriceEnvName(region, d),
      get id() {
        return (process.env[this.envName] || "").trim() || undefined;
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
// EARLY LAUNCH: while true the site shows "Early Launch Price" and, on the Japanese site, the struck "Regular" price
// below (DISPLAY_REGULAR). To END the early-launch pricing: (1) create the regular Price in Stripe and point
// STRIPE_PRICE_JP_DAY (and STRIPE_PRICE_INTL_DAY if its price changes) at it, (2) set EARLY_LAUNCH = false here,
// (3) redeploy. The labels and the "Regular" line then disappear from every page by themselves.
const EARLY_LAUNCH = true;
const DISPLAY_REGULAR = { jp: { day: 3000 } };

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
  SIMPLE_PRICE_ENV, CURRENCY, DISPLAY_REGULAR, EARLY_LAUNCH, expectedPrice,
};
