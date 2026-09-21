// netlify/functions/stripe-webhook.js
//
// Receives events directly from Stripe's servers (independent of the buyer's
// browser). This is the source of truth that a payment really happened —
// unlike the browser redirect back to success_url, which a user could in
// theory skip or fake, this request is cryptographically signed by Stripe.
//
// Point this URL at Stripe: https://<your-site>/.netlify/functions/stripe-webhook
// and subscribe it to the "checkout.session.completed" event in the Stripe
// Dashboard (Developers -> Webhooks). Stripe will give you a signing secret
// (whsec_...) — put that in Netlify as STRIPE_WEBHOOK_SECRET.

const Stripe = require("stripe");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error("Stripe env vars missing on webhook handler.");
    return { statusCode: 500, body: "Server not configured." };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
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

  if (stripeEvent.type === "checkout.session.completed") {
    const session = stripeEvent.data.object;

    // At this point the payment is confirmed. There is no database or email
    // service wired up yet, so for now this just logs the purchase — but
    // this is the correct place to add that fulfillment logic later
    // (e.g. record the purchase, email the PDF guide, grant access), using:
    //   session.id
    //   session.customer_details?.email
    //   session.amount_total, session.currency
    //   session.metadata.plan / .region / .city / .wl
    console.log("checkout.session.completed", {
      id: session.id,
      email: session.customer_details && session.customer_details.email,
      amount_total: session.amount_total,
      currency: session.currency,
      metadata: session.metadata,
    });
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
