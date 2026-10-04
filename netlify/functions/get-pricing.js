// netlify/functions/get-pricing.js
//
// Returns the FULL PLAN prices (same table create-checkout-session.js bills from) so the
// website can show the price for the number of days the buyer picked.
//   regions.jp   -> JPY      regions.intl -> USD
// `currency` / `full` at the top level are the JPY table (kept for older pages).

const { FULL_PLAN, amountsOf } = require("./lib/pricing");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  const regions = {};
  for (const r of Object.keys(FULL_PLAN)) regions[r] = { currency: FULL_PLAN[r].currency, full: amountsOf(r) };
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ currency: regions.jp.currency, full: regions.jp.full, regions }),
  };
};
