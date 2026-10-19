// netlify/functions/get-places.js
//
// GET → { cities: { Tokyo: { intro, spots: [{ name, genre, area, tags, note, lat, lng, price, best, when, order, pair, slot }] }, … } }
// The places shown on the site (plan building, FULL LIST, PDF). They live in the Supabase tables place_cities / places
// (edit them in the Table Editor); rows with published = false are left out. Cached at the CDN for 5 minutes.

const db = require("./lib/supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return { statusCode: 405, body: "Method Not Allowed" };
  try {
    const [cities, rows] = await Promise.all([
      db.select("place_cities?select=city,intro,sort&order=sort.asc"),
      db.select("places?published=eq.true&select=city,sort,name,genre,area,tags,note,lat,lng,price,best,visit_when,visit_order,pair,slot,instagram,website,map_url&order=city.asc,sort.asc&limit=5000"),
    ]);
    const out = {};
    for (const c of cities || []) out[c.city] = { intro: c.intro || "", spots: [] };
    for (const r of rows || []) {
      if (!out[r.city]) continue;
      const s = { name: r.name, genre: r.genre, area: r.area || "", tags: r.tags || [], note: r.note || "" };
      if (r.lat != null) s.lat = r.lat;
      if (r.lng != null) s.lng = r.lng;
      if (r.price) s.price = r.price;
      if (r.best) s.best = r.best;
      if (r.visit_when) s.when = r.visit_when;
      if (r.visit_order) s.order = r.visit_order;
      if (r.pair) s.pair = r.pair;
      if (r.slot) s.slot = r.slot;
      if (r.instagram) s.instagram = r.instagram;
      if (r.website) s.website = r.website;
      if (r.map_url) s.map = r.map_url;
      out[r.city].spots.push(s);
    }
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600" },
      body: JSON.stringify({ cities: out }),
    };
  } catch (err) {
    console.error("get-places failed", err.message);
    return { statusCode: 503, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ error: "unavailable" }) };
  }
};
