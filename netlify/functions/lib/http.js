// netlify/functions/lib/http.js — small response helpers (no caching of personal data).
const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(body),
});
module.exports = { json };
