// netlify/functions/get-trip.js
//
// POST (no body) with "Authorization: Bearer <device key>"
//   200 { purchase, trip }   trip is null for FULL LIST, or when no itinerary was saved yet
//   403 { error }            unknown / revoked / expired key, or purchase not paid (incl. refunds)
//   503 { error }            a Stripe re-check was needed and failed — access NOT granted, key kept
// Used by MY TRIPS, by page reloads, and to allow the FULL LIST re-download.

const db = require("./lib/supabase");
const { purchaseFromKey, AccessUnavailable } = require("./lib/access");
const { json } = require("./lib/http");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  try {
    const p = await purchaseFromKey(event);
    if (!p) return json(403, { error: "No access." });
    let trip = null;
    if (p.plan_type !== "list") {
      const t = await db.select(`trips?purchase_id=eq.${p.id}&select=title,itinerary,city,days,traveler,tags,version,updated_at,finalized_at`);
      trip = Array.isArray(t) && t[0] ? t[0] : null;
    }
    return json(200, {
      purchase: { id: p.id, plan: p.plan_type, days: p.days, city: p.city, region: p.region,
        currency: p.currency, amount_total: p.amount_total, paid_at: p.paid_at, created_at: p.created_at },
      trip,
    });
  } catch (err) {
    if (err instanceof AccessUnavailable) return json(503, { error: "Temporarily unavailable. Please try again shortly." });
    console.error("get-trip failed", err.message);
    return json(500, { error: "Please try again." });
  }
};
