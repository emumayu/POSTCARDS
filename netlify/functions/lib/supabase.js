// netlify/functions/lib/supabase.js
//
// Minimal Supabase client for Netlify Functions, using the REST API (PostgREST) with fetch.
// Uses the SECRET key (service_role) — server side only. Never import this from index.html.
//
// Env (Netlify, scope: Functions):
//   SUPABASE_URL         https://<project-ref>.supabase.co
//   SUPABASE_SECRET_KEY  sb_secret_...  (or the legacy service_role JWT)

function cfg() {
  // Accept the bare project URL, but also tolerate a pasted "/rest/v1" suffix.
  const url = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  const key = process.env.SUPABASE_SECRET_KEY || "";
  if (!url || !key) {
    const err = new Error("Supabase is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY).");
    err.code = "CONFIG";
    throw err;
  }
  return { url, key };
}

function headers(extra) {
  const { key } = cfg();
  const h = { apikey: key, "Content-Type": "application/json", Accept: "application/json" };
  // The legacy service_role key is a JWT and is also sent as a bearer token.
  // The new sb_secret_ keys are sent in the apikey header only.
  if (key.startsWith("eyJ")) h.Authorization = `Bearer ${key}`;
  return Object.assign(h, extra || {});
}

async function call(method, path, body, extraHeaders) {
  const { url } = cfg();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: headers(extraHeaders),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    const err = new Error(`Supabase ${method} ${path.split("?")[0]} failed (${res.status}): ${data && data.message ? data.message : text}`.slice(0, 500));
    err.status = res.status;
    err.pg = data && data.code;
    throw err;
  }
  return data;
}

// Call a database function (v7): returns its value.
const rpc = (fn, params) => call("POST", `rpc/${fn}`, params || {});
// SELECT: query like "purchases?id=eq.<uuid>&select=id,status"
const select = (query) => call("GET", query);
// INSERT ... ON CONFLICT (onConflict) DO UPDATE, returns the stored rows
const upsert = (table, row, onConflict) =>
  call("POST", `${table}?on_conflict=${encodeURIComponent(onConflict)}`, row, {
    Prefer: "resolution=merge-duplicates,return=representation",
  });
const insert = (table, row) => call("POST", table, row, { Prefer: "return=representation" });
const update = (query, patch) => call("PATCH", query, patch, { Prefer: "return=representation" });

module.exports = { rpc, select, upsert, insert, update };
