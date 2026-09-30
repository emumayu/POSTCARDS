// netlify/functions/lib/pricing.js
//
// FULL PLAN price by number of days (JPY). This is the ONLY place where these
// prices are defined:
//   - the website reads this table through /.netlify/functions/get-pricing
//     and shows exactly these numbers, and
//   - create-checkout-session.js charges Stripe from this same table.
// So the price shown on the page and the amount Stripe bills cannot differ.
//
// To change a price, edit the number here and deploy. Nothing else needs to change.
//
// NOTE: placeholder values — derived from the existing prices (1 Day Plan
// = ¥2,000 per day, Full Plan = ¥4,000 = 2 days). Replace with the real
// price list before selling.
//
// "+ tax" on the site is display wording only: Stripe charges exactly the
// number below (it does not add tax on top).
const FULL_PLAN_PRICES = {
  2: 4000,
  3: 6000,
  4: 8000,
  5: 10000,
};

const CURRENCY = "jpy"; // JPY has no minor unit: 4000 means ¥4,000

module.exports = { FULL_PLAN_PRICES, CURRENCY };
