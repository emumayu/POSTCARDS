// netlify/functions/stripe-webhook.js
//
// Stripe → POSTCARDS. Signature is verified first (unchanged). Then, for the events below,
// the purchase is re-read from Stripe and recorded by lib/purchase.js (the Webhook payload
// itself is never trusted), with duplicate-delivery protection from v7 claim_stripe_event():
//   1. claim_stripe_event(event.id, …)  false → already done / being processed → 200, nothing to do
//   2. syncPurchase(session)            the same code verify-session.js uses (card and PayPay alike)
//   3. success → stripe_events.status='done'
//      failure → stripe_events.status='failed' + error, reply 500 so Stripe retries
//                (a permanent problem — not a POSTCARDS purchase, price mismatch — replies 200)
//
// Events to enable on the Stripe endpoint:
//   checkout.session.completed, checkout.session.async_payment_succeeded,
//   checkout.session.async_payment_failed, charge.refunded

const Stripe = require("stripe");
const db = require("./lib/supabase");
const { syncPurchase, sessionIdForPaymentIntent } = require("./lib/purchase");

const HANDLED = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "charge.refunded",
]);

const reply = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

async function finish(eventId, ok, error) {
  try {
    await db.update(`stripe_events?id=eq.${encodeURIComponent(eventId)}`, ok
      ? { status: "done", processed_at: new Date().toISOString(), error: null }
      : { status: "failed", error: String(error || "").slice(0, 500) });
  } catch (err) {
    console.error("stripe-webhook: could not update stripe_events", eventId, err.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("Stripe env vars missing on webhook handler.");
    return { statusCode: 500, body: "Server not configured." };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2025-03-31.basil" });
  const signature = event.headers["stripe-signature"];

  let stripeEvent;
  try {
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : event.body;
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  if (!HANDLED.has(stripeEvent.type)) {
    return reply(200, { received: true, ignored: stripeEvent.type });
  }

  const obj = stripeEvent.data.object || {};
  const isCharge = stripeEvent.type === "charge.refunded";
  const paymentIntent = isCharge ? obj.payment_intent : (typeof obj.payment_intent === "string" ? obj.payment_intent : null);

  let sessionId = isCharge ? null : obj.id;
  try {
    if (isCharge) sessionId = await sessionIdForPaymentIntent(stripe, paymentIntent);
  } catch (err) {
    console.error("stripe-webhook: session lookup failed", stripeEvent.id, err.message);
    return reply(500, { error: "lookup failed" });
  }

  let claimed;
  try {
    claimed = await db.rpc("claim_stripe_event", {
      p_id: stripeEvent.id,
      p_type: stripeEvent.type,
      p_session: sessionId,
      p_payment_intent: paymentIntent,
    });
  } catch (err) {
    console.error("stripe-webhook: claim failed", stripeEvent.id, err.message);
    return reply(500, { error: "database unavailable" });
  }
  if (!claimed) return reply(200, { received: true, duplicate: true });

  try {
    if (!sessionId) {
      const e = new Error(`No Checkout Session for ${stripeEvent.type} (${paymentIntent || "no payment_intent"}).`);
      e.permanent = true;
      throw e;
    }
    const { state } = await syncPurchase(stripe, sessionId, {
      asyncFailed: stripeEvent.type === "checkout.session.async_payment_failed",
    });
    await finish(stripeEvent.id, true);
    console.log("stripe-webhook:", stripeEvent.type, sessionId, "->", state);
    return reply(200, { received: true, state });
  } catch (err) {
    console.error("stripe-webhook: processing failed", stripeEvent.id, err.message);
    await finish(stripeEvent.id, false, err.message);
    return err.permanent ? reply(200, { received: true, error: "not processed" }) : reply(500, { error: "processing failed" });
  }
};
