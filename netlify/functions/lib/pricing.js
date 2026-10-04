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
// To change a price: create the new Price in Stripe, then replace its id and amount here.
//
// 1 DAY PLAN and FULL LIST are NOT in this file. They keep using the Price IDs stored in the
// Netlify environment variables (STRIPE_PRICE_JP_DAY / _JP_LIST / _INTL_DAY / _INTL_LIST).
//
// "+ tax" on the site is display wording only: Stripe charges exactly the Price amount.
const FULL_PLAN = {
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

const regionOf = (v) => (v === "intl" ? "intl" : "jp");
const minorUnits = (currency, amount) => (currency === "jpy" ? amount : Math.round(amount * 100));
const amountsOf = (region) =>
  Object.fromEntries(Object.entries(FULL_PLAN[region].days).map(([d, v]) => [d, v.amount]));

module.exports = { FULL_PLAN, regionOf, minorUnits, amountsOf };
