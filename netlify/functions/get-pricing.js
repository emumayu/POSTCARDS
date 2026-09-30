// netlify/functions/get-pricing.js
//
// Returns the FULL PLAN price table so the website can show the price for the
// number of days the buyer picked. Same table create-checkout-session.js bills from.

const { FULL_PLAN_PRICES, CURRENCY } = require("./lib/pricing");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ currency: CURRENCY, full: FULL_PLAN_PRICES }),
  };
};
