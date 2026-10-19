// netlify/functions/verify-session.js
//
// POST { session_id }  — called by the page when the buyer returns from Stripe Checkout.
// Never trusts the URL: the purchase is re-read from Stripe (lib/purchase.js) and recorded.
//   200 { status:"paid", key, purchase, trip, email_hint }   paid: a device key is issued (v7 issue_checkout_key)
//        and the confirmation e-mail is sent once; email_hint ("ab***@example.com") is "" if it could not be sent
//   202 { status:"pending" }                      payment not confirmed yet (e.g. PayPay) — ask again
//   402 { status:"unpaid"|"failed"|"refunded"|"partially_refunded" }
//   409 { status:"paid", reissue:false }          already opened on another device more than 2h after payment
//   400 / 500                                     invalid request / server problem

const Stripe = require("stripe");
const db = require("./lib/supabase");
const { newKey, hashKey } = require("./lib/keys");
const { syncPurchase, PurchaseError } = require("./lib/purchase");
const { json } = require("./lib/http");
const { sendReceiptOnce, maskEmail } = require("./lib/receipt");

const publicPurchase = (p) => ({
  id: p.id, plan: p.plan_type, days: p.days, city: p.city, region: p.region,
  currency: p.currency, amount_total: p.amount_total, paid_at: p.paid_at, created_at: p.created_at,
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!process.env.STRIPE_SECRET_KEY) return json(500, { error: "Server not configured." });

  let sessionId;
  try { sessionId = String((JSON.parse(event.body || "{}") || {}).session_id || ""); }
  catch { return json(400, { error: "Invalid JSON body." }); }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-03-31.basil" });
  let result;
  try {
    result = await syncPurchase(stripe, sessionId);
  } catch (err) {
    if (err instanceof PurchaseError && err.permanent) {
      console.warn("verify-session: rejected", err.message);
      return json(402, { status: "unpaid" });
    }
    console.error("verify-session: sync failed", err.message);
    return json(500, { error: "Couldn't confirm the payment right now. Please try again." });
  }

  const { row, state } = result;
  if (state === "pending") return json(202, { status: "pending" });
  if (state !== "paid" || !row) return json(402, { status: state });

  try {
    const key = newKey();
    const keyId = await db.rpc("issue_checkout_key", { p_purchase_id: row.id, p_key_hash: hashKey(key) });
    if (!keyId) return json(409, { status: "paid", reissue: false });

    let trip = null;
    if (row.plan_type !== "list") {
      const t = await db.select(`trips?purchase_id=eq.${row.id}&select=title,itinerary,city,days,traveler,tags,version,updated_at,finalized_at`);
      trip = Array.isArray(t) && t[0] ? t[0] : null;
    }
    // Confirmation e-mail (once per purchase). The page shows where it went only when it really was sent.
    const receipt = await sendReceiptOnce(row, event).catch((e) => { console.error("verify-session: receipt", e.message); return { sent: false }; });
    const emailHint = receipt.sent || receipt.already ? maskEmail(row.email) : "";
    return json(200, { status: "paid", key, purchase: publicPurchase(row), trip, email_hint: emailHint });
  } catch (err) {
    console.error("verify-session: key / trip failed", err.message);
    return json(500, { error: "Couldn't confirm the payment right now. Please try again." });
  }
};
