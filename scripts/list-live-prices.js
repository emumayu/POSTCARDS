#!/usr/bin/env node
// scripts/list-live-prices.js
//
// READ-ONLY. Looks at the Prices that already exist in the Stripe account the key belongs to and prints the
// Netlify environment variables for them (STRIPE_PRICE_*). It only calls prices.list; it creates, changes and
// deletes nothing. Use a RESTRICTED key that can only read Prices (Dashboard > Developers > API keys > Create
// restricted key > "Prices: Read") — not the full secret key.
//
//   read -s STRIPE_SECRET_KEY && export STRIPE_SECRET_KEY     # paste the key (nothing is shown)
//   node scripts/list-live-prices.js
//
// A Price is matched to a variable by currency + amount (all 16 amounts are different within a currency).
// Anything missing, duplicated or inactive is reported instead of guessed.

const fs = require("fs");
const path = require("path");
const { FULL_PLAN } = require("../netlify/functions/lib/pricing");

const KEY = process.env.STRIPE_SECRET_KEY || "";
if (!/^(sk|rk)_(live|test)_/.test(KEY)) {
  console.error("Set STRIPE_SECRET_KEY to a Stripe key (a restricted read-only key is best).");
  process.exit(1);
}
const mode = KEY.includes("_live_") ? "LIVE" : "TEST";

const SIMPLE = { jp: { currency: "jpy", day: 2000, list: 5000 }, intl: { currency: "usd", day: 13, list: 32 } };
const R = { jp: "JP", intl: "INTL" };
const minor = (c, a) => (c === "jpy" ? a : Math.round(a * 100));

const wanted = []; // [env, currency, minor amount]
for (const r of Object.keys(SIMPLE)) {
  wanted.push([`STRIPE_PRICE_${R[r]}_DAY`, SIMPLE[r].currency, minor(SIMPLE[r].currency, SIMPLE[r].day)]);
  wanted.push([`STRIPE_PRICE_${R[r]}_LIST`, SIMPLE[r].currency, minor(SIMPLE[r].currency, SIMPLE[r].list)]);
}
for (const r of Object.keys(FULL_PLAN)) {
  for (const [d, v] of Object.entries(FULL_PLAN[r].days)) {
    wanted.push([`STRIPE_PRICE_${R[r]}_FULL_${d}`, FULL_PLAN[r].currency, minor(FULL_PLAN[r].currency, v.amount)]);
  }
}

(async () => {
  const stripe = require("stripe")(KEY);
  const all = [];
  // Product names are only for display; if the key can't read Products, fall back to Prices alone.
  try {
    for await (const p of stripe.prices.list({ limit: 100, expand: ["data.product"] })) all.push(p);
  } catch (e) {
    if (all.length) throw e;
    for await (const p of stripe.prices.list({ limit: 100 })) all.push(p);
  }
  console.log(`Mode: ${mode}. ${all.length} prices found.\n`);

  const lines = [];
  let problems = 0;
  for (const [env, cur, amt] of wanted) {
    const hits = all.filter((p) => p.currency === cur && p.unit_amount === amt && p.type === "one_time");
    const active = hits.filter((p) => p.active);
    const name = (p) => `${p.id} (${p.product && p.product.name ? p.product.name : "?"}${p.active ? "" : ", inactive"})`;
    if (active.length === 1) {
      lines.push(`${env}=${active[0].id}`);
      console.log(`ok       ${env.padEnd(26)} ${name(active[0])}`);
    } else if (active.length === 0) {
      problems++;
      console.log(`MISSING  ${env.padEnd(26)} no active one-time ${cur.toUpperCase()} ${amt} price${hits.length ? " (only inactive: " + hits.map(name).join(", ") + ")" : ""}`);
    } else {
      problems++;
      console.log(`AMBIGUOUS ${env.padEnd(25)} ${active.map(name).join(" / ")}`);
    }
  }
  const out = path.join(__dirname, `${mode.toLowerCase()}-prices.env`);
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(`\n${lines.length}/${wanted.length} matched. Saved to ${out}${problems ? `\n${problems} need attention (see above).` : ""}\n\n${lines.join("\n")}`);
})().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
