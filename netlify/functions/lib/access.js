// netlify/functions/lib/access.js
//
// purchaseFromKey(event) — who may open / save an itinerary or re-download FULL LIST.
//   1. The device key ("Authorization: Bearer <key>") is checked by v7 check_device_key():
//      valid, not revoked, not expired, and the stored purchase status is 'paid'.
//   2. If the stored status was confirmed with Stripe recently (status_checked_at within
//      STATUS_RECHECK_SECONDS, default 600 = 10 minutes) it is trusted as is: no Stripe call.
//   3. Otherwise the payment state is re-read from Stripe (refreshPurchaseStatus) before
//      answering, so a refund is caught even if the charge.refunded Webhook hasn't arrived.
//
// Returns the purchase row (status 'paid'), or null = no access (403).
// Throws AccessUnavailable when a Stripe re-check was needed but failed (outage, timeout,
// session not found): the caller answers 503 and access is NOT granted. Nothing is changed
// in the database, and the buyer's key stays valid for when Stripe answers again.
//
// Status handling: paid -> allowed; refunded / partially_refunded / failed / pending -> 403.

const Stripe = require("stripe");
const db = require("./supabase");
const { readKey, hashKey } = require("./keys");
const { refreshPurchaseStatus } = require("./purchase");

class AccessUnavailable extends Error {}

const recheckMs = () => {
  const v = parseInt(process.env.STATUS_RECHECK_SECONDS || "600", 10);
  return (Number.isFinite(v) && v > 0 ? v : 600) * 1000;
};

async function purchaseFromKey(event) {
  const key = readKey(event);
  if (!key) return null;
  const purchaseId = await db.rpc("check_device_key", { p_key_hash: hashKey(key) });
  if (!purchaseId) return null;
  const rows = await db.select(
    `purchases?id=eq.${encodeURIComponent(purchaseId)}&select=id,stripe_session_id,plan_type,status,days,city,region,currency,amount_total,paid_at,created_at,status_checked_at,email,site_origin`
  );
  const p = Array.isArray(rows) && rows[0] ? rows[0] : null;
  if (!p || p.status !== "paid") return null;

  const last = p.status_checked_at ? Date.parse(p.status_checked_at) : 0;
  if (Number.isFinite(last) && Date.now() - last < recheckMs()) return p;

  if (!process.env.STRIPE_SECRET_KEY) throw new AccessUnavailable("Stripe is not configured.");
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-03-31.basil" });
  let fresh;
  try {
    fresh = await refreshPurchaseStatus(stripe, p);
  } catch (err) {
    console.warn("access: Stripe re-check failed, access refused for now", p.id, err.message);
    throw new AccessUnavailable(err.message);
  }
  return fresh.row && fresh.row.status === "paid" ? Object.assign({}, p, fresh.row) : null;
}

module.exports = { purchaseFromKey, AccessUnavailable };
