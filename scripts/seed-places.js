#!/usr/bin/env node
// scripts/seed-places.js
//
// One-time import of the places (supabase/seed/places.json, exported from the data that used to be embedded in
// index.html) into the Supabase project you point it at. Run it once per project (dev, then prod).
// It refuses to run when the places table already has rows, so it can't create duplicates.
//
//   node scripts/seed-places.js     # asks for the project URL and the secret key (hidden)

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { getKey } = require("./prompt-key");

const ask = (q) => new Promise((ok) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, (a) => { rl.close(); ok(a.trim()); }); });

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "supabase", "seed", "places.json"), "utf8"));
  const url = (process.env.SUPABASE_URL || (await ask("Supabase project URL (https://xxxx.supabase.co): "))).replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const key = await getKey("SUPABASE_SECRET_KEY", "Supabase secret key (hidden): ");
  if (!url || !key) throw new Error("URL and key are required");
  const h = { apikey: key, "Content-Type": "application/json", Prefer: "return=minimal" };
  if (key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`;
  const call = async (method, p, body, extra) => {
    const r = await fetch(`${url}/rest/v1/${p}`, { method, headers: Object.assign({}, h, extra || {}), body: body === undefined ? undefined : JSON.stringify(body) });
    const t = await r.text();
    if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${t.slice(0, 300)}`);
    return t;
  };
  const existing = await fetch(`${url}/rest/v1/places?select=id&limit=1`, { headers: h });
  if (!existing.ok) throw new Error(`cannot read places (${existing.status}) — is the migration applied?`);
  if ((await existing.json()).length) { console.log("places already has rows — nothing imported."); return; }
  await call("POST", "place_cities?on_conflict=city", data.cities, { Prefer: "resolution=ignore-duplicates,return=minimal" });
  for (let i = 0; i < data.places.length; i += 100) await call("POST", "places", data.places.slice(i, i + 100));
  const n = await fetch(`${url}/rest/v1/places?select=id`, { headers: Object.assign({}, h, { Prefer: "count=exact", Range: "0-0" }) });
  console.log(`imported ${data.places.length} places in ${data.cities.length} cities; table now reports ${n.headers.get("content-range")}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
