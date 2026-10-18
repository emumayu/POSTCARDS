#!/usr/bin/env node
// scripts/create-sandbox-prices.js
//
// Creates the POSTCARDS products and the 16 one-time Prices in the Stripe SANDBOX (test mode) and prints the
// matching Netlify environment variables. It refuses to run with a live key.
//
//   read -s STRIPE_SECRET_KEY && export STRIPE_SECRET_KEY     # paste the sk_test_... key (nothing is shown)
//   node scripts/create-sandbox-prices.js [--dry-run]
//
// Safe to run again: every Price has a lookup_key, so existing ones are reused (nothing is created twice).
// Amounts come from netlify/functions/lib/pricing.js (FULL PLAN) and the table below (1 DAY / FULL LIST).

const fs = require("fs");
const path = require("path");
const { FULL_PLAN } = require("../netlify/functions/lib/pricing");

const DRY = process.argv.includes("--dry-run");
const KEY = process.env.STRIPE_SECRET_KEY || "";
if (!DRY && !/^(sk|rk)_test_/.test(KEY)) {
  console.error("Set STRIPE_SECRET_KEY to a TEST-mode key (sk_test_...). Live keys are refused.");
  process.exit(1);
}

// region -> { currency, unit amounts in major units }
const SIMPLE = {
  jp: { currency: "jpy", day: 2000, list: 5000 },
  intl: { currency: "usd", day: 13, list: 32 },
};
const minor = (currency, amount) => (currency === "jpy" ? amount : Math.round(amount * 100));
const REGION_ENV = { jp: "JP", intl: "INTL" };

// The plan: [product key, env var, lookup_key, currency, major amount, nickname]
const plan = [];
for (const r of Object.keys(SIMPLE)) {
  plan.push(["day", `STRIPE_PRICE_${REGION_ENV[r]}_DAY`, `postcards_${r}_day`, SIMPLE[r].currency, SIMPLE[r].day, `1 DAY PLAN (${r})`]);
  plan.push(["list", `STRIPE_PRICE_${REGION_ENV[r]}_LIST`, `postcards_${r}_list`, SIMPLE[r].currency, SIMPLE[r].list, `FULL LIST (${r})`]);
}
for (const r of Object.keys(FULL_PLAN)) {
  for (const [d, v] of Object.entries(FULL_PLAN[r].days)) {
    plan.push(["full", `STRIPE_PRICE_${REGION_ENV[r]}_FULL_${d}`, `postcards_${r}_full_${d}`, FULL_PLAN[r].currency, v.amount, `FULL PLAN ${d} DAYS (${r})`]);
  }
}
const PRODUCTS = { day: "POSTCARDS 1 DAY PLAN", full: "POSTCARDS FULL PLAN", list: "POSTCARDS FULL LIST" };

(async () => {
  if (DRY) {
    for (const [p, env, lk, cur, amt] of plan) console.log(`${env.padEnd(26)} ${cur} ${String(minor(cur, amt)).padStart(6)}  [${lk}] -> ${PRODUCTS[p]}`);
    console.log(`\n(dry run: ${plan.length} prices, nothing created)`);
    return;
  }
  const stripe = require("stripe")(KEY);
  const products = {};
  for (const [k, name] of Object.entries(PRODUCTS)) {
    const found = await stripe.products.search({ query: `active:'true' AND metadata['postcards_plan']:'${k}'`, limit: 1 });
    products[k] = found.data[0] || (await stripe.products.create({ name, metadata: { postcards_plan: k } }));
    console.log(`product ${k}: ${products[k].id}`);
  }
  const lines = [];
  for (const [p, env, lk, cur, amt, nick] of plan) {
    const have = await stripe.prices.list({ lookup_keys: [lk], active: true, limit: 1 });
    let price = have.data[0];
    if (price && (price.unit_amount !== minor(cur, amt) || price.currency !== cur)) {
      throw new Error(`Existing price ${price.id} (${lk}) has a different amount/currency; archive it in the dashboard first.`);
    }
    if (!price) {
      price = await stripe.prices.create({ product: products[p].id, currency: cur, unit_amount: minor(cur, amt), lookup_key: lk, nickname: nick });
      console.log(`created ${env} = ${price.id}`);
    } else console.log(`reused  ${env} = ${price.id}`);
    lines.push(`${env}=${price.id}`);
  }
  const out = path.join(__dirname, "sandbox-prices.env");
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(`\nSaved ${lines.length} variables to ${out}\n\n${lines.join("\n")}`);
})().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
