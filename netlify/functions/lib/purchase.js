// netlify/functions/lib/purchase.js
//
// syncPurchase(stripe, sessionId, opts)
//   The one place that decides whether a purchase is paid. It never trusts URL parameters or
//   Webhook payloads: it re-reads the Checkout Session from Stripe, checks that the Price,
//   currency and amount are exactly what POSTCARDS sells for that plan / region / days, maps the
//   Stripe state to the v7 purchase status, and upserts public.purchases (one row per session).
//   Card and PayPay go through the same code (no branching on the payment method).
//
//   Returns { row, state }  state: "unpaid" (checkout not completed — nothing stored)
//                                  | "pending" | "paid" | "failed" | "partially_refunded" | "refunded"
//   Throws PurchaseError (permanent: true) when the session is not a valid POSTCARDS purchase.
//
//   The Price / currency / amount check runs only the FIRST time a session is recorded.
//   Once a purchase is in public.purchases, later calls (Webhook refunds, PayPay results,
//   re-issue from the return page, access re-checks) only refresh its payment status
//   (refreshPurchaseStatus) — so changing a Price ID later never locks out past buyers.

const { regionOf, minorUnits, expectedPrice } = require("./pricing");
const db = require("./supabase");
const { safeOrigin } = require("./mail");

class PurchaseError extends Error {
  constructor(message, permanent = true) { super(message); this.permanent = permanent; }
}

const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;
const PLANS = ["day", "full", "list"];

function stateOf(session, pi, charge, opts) {
  const ps = session.payment_status;
  if (session.status !== "complete") return "unpaid";
  let state;
  if (ps === "paid" || ps === "no_payment_required") state = "paid";
  else if (opts && opts.asyncFailed) state = "failed";
  else if (pi && (pi.status === "canceled" || pi.status === "requires_payment_method")) state = "failed";
  else state = "pending";
  if (state === "paid" && charge && charge.amount_refunded > 0) {
    state = charge.refunded ? "refunded" : "partially_refunded";
  }
  return state;
}

async function retrieveSession(stripe, sessionId, expand) {
  try {
    return await stripe.checkout.sessions.retrieve(sessionId, { expand });
  } catch (err) {
    if (err && err.statusCode === 404) throw new PurchaseError("Checkout Session not found.");
    throw new PurchaseError(`Stripe lookup failed: ${err.message}`, false);
  }
}

// Re-reads ONLY the payment state of an already recorded purchase from Stripe and stores it.
// No Price check (that was done when the purchase was first recorded). purchases_guard (v7)
// keeps the status moving forward only, so a stale "paid" can never undo a refund.
// Any Stripe problem (outage, timeout, session not found) is thrown as a non-permanent
// PurchaseError and the stored row is left as it was.
async function refreshPurchaseStatus(stripe, row, opts) {
  let s;
  try {
    s = await stripe.checkout.sessions.retrieve(row.stripe_session_id, { expand: ["payment_intent.latest_charge"] });
  } catch (err) {
    throw new PurchaseError(`Stripe lookup failed: ${err.message}`, false);
  }
  const pi = s.payment_intent && typeof s.payment_intent === "object" ? s.payment_intent : null;
  const charge = pi && pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const state = stateOf(s, pi, charge, opts);
  const now = new Date().toISOString();
  const patch = { status_checked_at: now };
  if (state !== "unpaid") {
    const paidLike = state === "paid" || state === "partially_refunded" || state === "refunded";
    patch.status = state;
    patch.amount_refunded = charge ? charge.amount_refunded || 0 : 0;
    if (state === "refunded" || state === "partially_refunded") patch.refunded_at = now;
    if (paidLike) patch.paid_at = new Date(((charge && charge.created) || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    if (charge && charge.payment_method_details) patch.payment_method_type = charge.payment_method_details.type;
    if (pi) patch.stripe_payment_intent = pi.id;
  }
  const updated = await db.update(`purchases?id=eq.${encodeURIComponent(row.id)}`, patch);
  const saved = Array.isArray(updated) && updated[0] ? updated[0] : row;
  return { row: saved, state: saved.status };
}

async function syncPurchase(stripe, sessionId, opts) {
  if (!SESSION_RE.test(sessionId || "")) throw new PurchaseError("Invalid session id.");

  // Already recorded? Then only refresh the payment state (no Price check).
  let existing;
  try {
    const found = await db.select(`purchases?stripe_session_id=eq.${encodeURIComponent(sessionId)}&select=*`);
    existing = Array.isArray(found) && found[0] ? found[0] : null;
  } catch (err) {
    throw new PurchaseError(`Database lookup failed: ${err.message}`, false);
  }
  if (existing) return refreshPurchaseStatus(stripe, existing, opts);

  const s = await retrieveSession(stripe, sessionId, ["line_items", "payment_intent.latest_charge"]);

  // ---- what was bought (from the session metadata written by create-checkout-session.js)
  const md = s.metadata || {};
  const plan = md.plan;
  if (!PLANS.includes(plan)) throw new PurchaseError(`Not a POSTCARDS purchase (plan "${plan}").`);
  const region = regionOf(md.region);
  const days = plan === "full" ? parseInt(md.days, 10) : plan === "day" ? 1 : null;
  const exp = expectedPrice(plan, region, plan === "full" ? days : null);
  if (!exp) throw new PurchaseError(`No Price configured for ${plan}/${region}/${days}.`);

  // ---- the Price, currency and amount must be exactly what we sell
  const items = (s.line_items && s.line_items.data) || [];
  if (items.length !== 1) throw new PurchaseError(`Expected 1 line item, got ${items.length}.`);
  const item = items[0];
  const price = item.price || {};
  if (price.id !== exp.id) throw new PurchaseError(`Price mismatch (${price.id} != ${exp.id}).`);
  if (item.quantity !== 1) throw new PurchaseError(`Quantity ${item.quantity}.`);
  if (price.currency !== exp.currency || s.currency !== exp.currency) {
    throw new PurchaseError(`Currency mismatch (${s.currency}/${price.currency} != ${exp.currency}).`);
  }
  if (exp.amount != null && price.unit_amount !== minorUnits(exp.currency, exp.amount)) {
    throw new PurchaseError(`Amount mismatch (${price.unit_amount} != ${minorUnits(exp.currency, exp.amount)}).`);
  }
  // Before discount (promotion codes are allowed, so amount_total may be lower).
  if (s.amount_subtotal !== price.unit_amount) {
    throw new PurchaseError(`Subtotal mismatch (${s.amount_subtotal} != ${price.unit_amount}).`);
  }

  // ---- payment state
  const pi = s.payment_intent && typeof s.payment_intent === "object" ? s.payment_intent : null;
  const charge = pi && pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  const state = stateOf(s, pi, charge, opts);
  if (state === "unpaid") return { row: null, state };

  const now = new Date().toISOString();
  const paidLike = state === "paid" || state === "partially_refunded" || state === "refunded";
  const email = s.customer_details && s.customer_details.email ? String(s.customer_details.email).trim().toLowerCase() : null;
  const stripeCustomerId = typeof s.customer === "string" ? s.customer : (s.customer && s.customer.id) || null;
  // Guest buyer record (no login): find-or-create by e-mail. A failure is retried (Webhook 500).
  let customerId = null;
  if (email) {
    try {
      customerId = await db.rpc("upsert_customer", { p_email: email, p_stripe_customer_id: stripeCustomerId });
    } catch (err) {
      throw new PurchaseError(`Customer upsert failed: ${err.message}`, false);
    }
  }
  const row = {
    stripe_session_id: s.id,
    plan_type: plan,
    status: state,
    email,
    customer_id: customerId,
    stripe_customer_id: stripeCustomerId,
    city: md.city || null,
    site_origin: safeOrigin(md.origin),
    region,
    days,
    price_id: price.id,
    amount_subtotal: s.amount_subtotal,       // minor units (yen / cents), as Stripe stores them
    amount_total: s.amount_total,
    amount_refunded: charge ? charge.amount_refunded || 0 : 0,
    currency: s.currency,
    livemode: !!s.livemode,
    stripe_payment_intent: pi ? pi.id : (typeof s.payment_intent === "string" ? s.payment_intent : null),
    payment_method_type: charge && charge.payment_method_details ? charge.payment_method_details.type : null,
    // When the payment was confirmed (purchases_guard keeps the first value written).
    paid_at: paidLike ? new Date(((charge && charge.created) || Math.floor(Date.now() / 1000)) * 1000).toISOString() : null,
    refunded_at: state === "refunded" || state === "partially_refunded" ? now : null,
    status_checked_at: now,
  };

  const stored = await db.upsert("purchases", row, "stripe_session_id");
  const saved = Array.isArray(stored) ? stored[0] : stored;
  // purchases_guard may have kept a "later" status (e.g. refunded) — the stored row wins.
  return { row: saved, state: saved ? saved.status : state };
}

// The Checkout Session behind a PaymentIntent (used for charge.refunded).
async function sessionIdForPaymentIntent(stripe, paymentIntentId) {
  if (!paymentIntentId) return null;
  const list = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
  return list && list.data && list.data[0] ? list.data[0].id : null;
}

module.exports = { syncPurchase, refreshPurchaseStatus, sessionIdForPaymentIntent, PurchaseError, SESSION_RE };
