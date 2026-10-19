// netlify/functions/save-trip.js
//
// POST { title, itinerary, traveler, tags, final? } with "Authorization: Bearer <device key>"
// Saves the itinerary of a paid 1 DAY / FULL PLAN purchase: one row per purchase
// (trips.purchase_id is unique); rebuilding overwrites it and adds 1 to version.
// With final:true the buyer has confirmed "SAVE MY ITINERARY": the row gets finalized_at and from then on every
// further save for this purchase is refused (409) — the itinerary can no longer be rebuilt.
//   200 { ok:true, email (final saves only), version, updated_at, finalized_at }   403 no access   400 invalid itinerary
//   409 { error:"locked" }   the itinerary was already saved as final
//   503 a Stripe re-check was needed and failed — nothing saved, key kept (the page retries)

const db = require("./lib/supabase");
const { purchaseFromKey, AccessUnavailable } = require("./lib/access");
const { json } = require("./lib/http");
const { sendTripSavedMail } = require("./lib/receipt");

const MAX_BYTES = 200 * 1024;
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);

function cleanItinerary(it, days) {
  if (!it || typeof it !== "object" || !Array.isArray(it.days)) return null;
  if (it.days.length !== days) return null;
  const outDays = [];
  for (const d of it.days) {
    if (!d || !Array.isArray(d.items) || d.items.length > 14) return null;
    outDays.push({
      title: str(d.title, 120) || "",
      items: d.items.map((x) => ({
        time: str(x && x.time, 12) || "",
        name: str(x && x.name, 160) || "",
        why: str(x && x.why, 600) || "",
        ...(x && x.rest ? { rest: true } : {}),
      })),
    });
  }
  const area = it.area && typeof it.area === "object"
    ? { city: str(it.area.city, 60), id: str(it.area.id, 160), en: str(it.area.en, 160), jp: str(it.area.jp, 160) }
    : null;
  return {
    title: str(it.title, 160) || "",
    hotel: str(it.hotel, 160),
    hotels: Array.isArray(it.hotels) ? it.hotels.slice(0, 4).map((h) => str(h, 160)).filter(Boolean) : [],
    days: outDays,
    closing: str(it.closing, 300) || "",
    area,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  if ((event.body || "").length > MAX_BYTES) return json(413, { error: "Itinerary too large." });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON body." }); }

  try {
    const p = await purchaseFromKey(event);
    if (!p) return json(403, { error: "No access." });
    if (p.plan_type !== "day" && p.plan_type !== "full") return json(400, { error: "This purchase has no itinerary." });

    const days = p.plan_type === "day" ? 1 : p.days;
    const itinerary = cleanItinerary(body.itinerary, days);
    if (!itinerary) return json(400, { error: "Invalid itinerary." });

    const fields = {
      title: str(body.title, 160) || itinerary.title || null,
      itinerary,
      city: p.city,
      plan_type: p.plan_type,
      days,
      traveler: str(body.traveler, 80),
      tags: Array.isArray(body.tags) ? body.tags.slice(0, 40).map((t) => str(t, 40)).filter(Boolean) : [],
    };

    const final = body.final === true;
    if (final) fields.finalized_at = new Date().toISOString();

    const existing = await db.select(`trips?purchase_id=eq.${p.id}&select=id,version,finalized_at`);
    if (Array.isArray(existing) && existing[0] && existing[0].finalized_at) {
      return json(409, { error: "locked", finalized_at: existing[0].finalized_at });
    }
    let saved;
    if (Array.isArray(existing) && existing[0]) {
      const r = await db.update(`trips?id=eq.${existing[0].id}&finalized_at=is.null`, { ...fields, version: (existing[0].version || 1) + 1 });
      if (!r || !r[0]) return json(409, { error: "locked" });   // finalized by another request in the meantime
      saved = r[0];
    } else {
      try {
        const r = await db.insert("trips", { ...fields, purchase_id: p.id, user_id: null, version: 1 });
        saved = r && r[0];
      } catch (err) {
        if (err.pg !== "23505") throw err; // another save created it a moment ago
        const again = await db.select(`trips?purchase_id=eq.${p.id}&select=id,version`);
        const r = await db.update(`trips?id=eq.${again[0].id}&finalized_at=is.null`, { ...fields, version: (again[0].version || 1) + 1 });
        if (!r || !r[0]) return json(409, { error: "locked" });
        saved = r[0];
      }
    }
    if (final && saved) await sendTripSavedMail(p, { title: fields.title, itinerary }, event);   // PDF link by e-mail (never fails the save)
    return json(200, { ok: true, email: final ? (p.email || null) : null, version: saved ? saved.version : null, updated_at: saved ? saved.updated_at : null, finalized_at: saved ? saved.finalized_at || null : null });
  } catch (err) {
    if (err instanceof AccessUnavailable) return json(503, { error: "Temporarily unavailable. Please try again shortly." });
    console.error("save-trip failed", err.message);
    return json(500, { error: "Please try again." });
  }
};
