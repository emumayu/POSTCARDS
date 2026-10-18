// netlify/functions/lib/keys.js
//
// Guest access keys (v7 access_keys). The raw key is 32 random bytes (base64url, 43 chars):
// it is handed to the buyer's browser once and never stored or logged on the server.
// Only its SHA-256 (hex) reaches the database.

const crypto = require("crypto");

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

const newKey = () => crypto.randomBytes(32).toString("base64url");
const hashKey = (key) => crypto.createHash("sha256").update(key, "utf8").digest("hex");

// Reads "Authorization: Bearer <key>". Returns null for anything that is not a well-formed key.
function readKey(event) {
  const h = (event.headers && (event.headers.authorization || event.headers.Authorization)) || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m && KEY_RE.test(m[1]) ? m[1] : null;
}

module.exports = { newKey, hashKey, readKey, KEY_RE };
