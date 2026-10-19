// netlify/functions/sync-places.js
//
// Called by the Google Sheet (Apps Script menu "POSTCARDS"). Auth: Authorization: Bearer <SYNC_TOKEN> (Netlify env).
//
//   POST { action:"enrich", rows:[{ key, name, area, city }] }   (up to 10 rows per call)
//     → { results:[{ key, ok, lat, lng, website, map_url, place_id, status, matched } | { key, ok:false, status:"NOT_FOUND" }] }
//     Looks every row up in the Google Places API (GOOGLE_PLACES_API_KEY) so the sheet can fill lat/lng, the official
//     website, the Google Maps link and the business status. Nothing is written to the database here.
//
//   POST { action:"sync", rows:[ <sheet row> ... ], force? }   (the whole sheet)
//     → { ok, upserted, deleted, published, warnings:[…] }
//     The sheet is the source of truth: rows are upserted by `key`, rows that are no longer in the sheet are deleted.
//     A sync that would delete more than 30% of the places is refused unless force is true.
//
// Sheet row fields: key, city, name, area, genre, tags ("a,b"), note, price, instagram, website, map, lat, lng,
//   published ("公開" = shown on the site), status, matched, placeId, best, when, order, pair, slot.

const crypto = require("crypto");
const db = require("./lib/supabase");

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) });

function authorized(event) {
  const want = process.env.SYNC_TOKEN || "";
  const got = ((event.headers && (event.headers.authorization || event.headers.Authorization)) || "").replace(/^Bearer\s+/i, "");
  if (!want || want.length < 16 || !got) return false;
  const a = crypto.createHash("sha256").update(got).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

const clean = (v) => (v == null ? "" : String(v).trim());
const num = (v) => { const n = parseFloat(clean(v)); return Number.isFinite(n) ? n : null; };
const emptyToNull = (v) => { const s = clean(v); return s ? s : null; };
const igOf = (v) => { const s = clean(v); return /^@?[A-Za-z0-9._]+$/.test(s) && s !== "要確認" ? s : /^https?:\/\/(www\.)?instagram\.com\//i.test(s) ? s : null; };
const urlOf = (v) => { const s = clean(v); return /^https?:\/\//i.test(s) ? s : null; };

// ---------- enrich (Google Places API, Text Search "New") ----------
const TOKYO = { circle: { center: { latitude: 35.68, longitude: 139.76 }, radius: 40000 } };

async function lookup(row) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY is not set");
  const q = [clean(row.name), clean(row.area), clean(row.city) || "Tokyo"].filter(Boolean).join(" ");
  const body = { textQuery: q, languageCode: "ja", regionCode: "JP", maxResultCount: 1 };
  if (!row.city || /^tokyo$/i.test(row.city)) body.locationBias = TOKYO;
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.websiteUri,places.googleMapsUri,places.businessStatus",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Places API ${res.status}: ${(data.error && data.error.message) || ""}`.slice(0, 200));
  const p = data.places && data.places[0];
  if (!p) return { key: row.key, ok: false, status: "NOT_FOUND" };
  return {
    key: row.key,
    ok: true,
    lat: p.location ? p.location.latitude : null,
    lng: p.location ? p.location.longitude : null,
    website: p.websiteUri || "",
    map_url: p.googleMapsUri || "",
    place_id: p.id || "",
    status: p.businessStatus || "",
    matched: (p.displayName && p.displayName.text) || "",
  };
}

async function enrich(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 10) return json(400, { error: "rows: 1 to 10 per call" });
  const results = await Promise.all(rows.map((r) => lookup(r).catch((e) => ({ key: r.key, ok: false, status: "ERROR", error: e.message }))));
  return json(200, { results });
}

// ---------- sync (sheet → Supabase) ----------
function toDbRows(rows, warnings) {
  const seen = new Set();
  const perCity = {};
  const out = [];
  rows.forEach((r, i) => {
    const key = clean(r.key), name = clean(r.name), city = clean(r.city);
    if (!key || !name || !city) { warnings.push(`row ${i + 1}: key / city / name is missing — skipped`); return; }
    if (seen.has(key)) { warnings.push(`row ${i + 1}: duplicate key ${key} — skipped`); return; }
    seen.add(key);
    perCity[city] = (perCity[city] || 0);
    const genre = clean(r.genre).toLowerCase();
    const status = clean(r.status);
    let published = clean(r.published) === "公開";
    if (published && !genre) { published = false; warnings.push(`${name}: ジャンルが空のため非公開にしました`); }
    if (published && status === "CLOSED_PERMANENTLY") { published = false; warnings.push(`${name}: 閉店のため非公開にしました`); }
    out.push({
      key, city, sort: perCity[city]++, name, genre: genre || "", area: clean(r.area),
      tags: clean(r.tags) ? clean(r.tags).split(/[,、]/).map((t) => t.trim()).filter(Boolean) : [],
      note: clean(r.note), price: emptyToNull(r.price), lat: num(r.lat), lng: num(r.lng),
      instagram: igOf(r.instagram), website: urlOf(r.website),
      map_url: urlOf(r.map) && !/\/maps\/search\//.test(clean(r.map)) ? clean(r.map) : null,
      place_id: emptyToNull(r.placeId), business_status: emptyToNull(status), matched_name: emptyToNull(r.matched),
      best: emptyToNull(r.best), visit_when: emptyToNull(r.when), visit_order: emptyToNull(r.order), pair: emptyToNull(r.pair), slot: emptyToNull(r.slot),
      published,
    });
  });
  return out;
}

async function sync(rows, force) {
  if (!Array.isArray(rows) || !rows.length) return json(400, { error: "rows is empty" });
  const warnings = [];
  const dbRows = toDbRows(rows, warnings);
  if (!dbRows.length) return json(400, { error: "no valid rows", warnings });
  const existing = (await db.select("places?select=id,key&limit=10000")) || [];
  const keys = new Set(dbRows.map((r) => r.key));
  const gone = existing.filter((e) => !e.key || !keys.has(e.key));
  if (!force && existing.length >= 20 && gone.length > existing.length * 0.3) {
    return json(409, { error: "too_many_deletions", would_delete: gone.length, existing: existing.length, warnings });
  }
  const cities = [...new Set(dbRows.map((r) => r.city))];
  await db.upsert("place_cities", cities.map((c) => ({ city: c })), "city").catch(() => null);
  for (let i = 0; i < dbRows.length; i += 100) await db.upsert("places", dbRows.slice(i, i + 100), "key");
  for (let i = 0; i < gone.length; i += 100) await db.del(`places?id=in.(${gone.slice(i, i + 100).map((g) => g.id).join(",")})`);
  return json(200, { ok: true, upserted: dbRows.length, deleted: gone.length, published: dbRows.filter((r) => r.published).length, warnings });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });
  if (!authorized(event)) return json(401, { error: "Unauthorized" });
  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON" }); }
  try {
    if (body.action === "enrich") return await enrich(body.rows);
    if (body.action === "sync") return await sync(body.rows, body.force === true);
    return json(400, { error: "action must be enrich or sync" });
  } catch (err) {
    console.error("sync-places failed", err.message);
    return json(500, { error: "failed", message: String(err.message || err).slice(0, 300) });
  }
};
exports._toDbRows = toDbRows;
