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
// Prices come from the "How many days?" screen of the design (¥ before tax).
// 1 DAY (¥2,700, early launch ¥2,000) is a separate product (1 Day Plan) and uses its Stripe Price ID.
//
// "+ tax" on the site is display wording only: Stripe charges exactly the
// number below (it does not add tax on top).
const FULL_PLAN_PRICES = {
  2: 4000,
  3: 5500,
  4: 6500,
  5: 7500,
  6: 8500,
  7: 9500,
};

const CURRENCY = "jpy"; // JPY has no minor unit: 4000 means ¥4,000

module.exports = { FULL_PLAN_PRICES, CURRENCY };
