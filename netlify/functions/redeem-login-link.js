// netlify/functions/redeem-login-link.js
//
// POST { token }   called by the page when it is opened from the e-mailed link (/?login=<token>).
//   200 { keys: [{ key, purchase }] }   one new device key per paid purchase of the customer
//   410 { error }                       unknown, already used or expired link
// The keys are handed over once and never stored in clear text (only their hashes reach the database).

const db = require("./lib/supabase");
const { newKey, hashKey, KEY_RE } = require("./lib/keys");
const { json } = require("./lib/http");

const publicPurchase = (p) => ({
  id: p.id, plan: p.plan_type, days: p.days, city: p.city, region: p.region,
  currency: p.currency, amount_total: p.amount_total, paid_at: p.paid_at, created_at: p.created_at,
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let token;
  try { token = String((JSON.parse(event.body || "{}") || {}).token || ""); }
  catch { return json(400, { error: "Invalid JSON body." }); }
  if (!KEY_RE.test(token)) return json(410, { error: "This link is not valid." });

  try {
    const got = await db.rpc("redeem_login_token", { p_token_hash: hashKey(token) });
    if (!got) return json(410, { error: "This link has expired or was already used." });

    const purchases = Array.isArray(got.purchases) ? got.purchases : [];
    const issued = purchases.map((p) => ({ p, key: newKey() }));
    const served = await db.rpc("issue_login_keys", {
      p_customer_id: got.customer_id,
      p_keys: issued.map((x) => ({ purchase_id: x.p.id, key_hash: hashKey(x.key) })),
    });
    const ok = new Set(Array.isArray(served) ? served : []);
    return json(200, { keys: issued.filter((x) => ok.has(x.p.id)).map((x) => ({ key: x.key, purchase: publicPurchase(x.p) })) });
  } catch (err) {
    console.error("redeem-login-link failed", err.message);
    return json(500, { error: "Please try again." });
  }
};
