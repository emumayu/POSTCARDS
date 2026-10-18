// netlify/functions/request-login-link.js
//
// POST { email, lang }   "Send me a link to open my trips on this device" (MY TRIPS).
//   200 { ok:true }   always, whether or not the e-mail has a purchase (so nobody can use this to find out
//                     who bought). A link is mailed only when the e-mail has a paid purchase and the
//                     customer hasn't asked for 3 links in the last 15 minutes (enforced in the database).
//   400               not an e-mail address
// The link is  <site>/?login=<token>  — single use, valid 15 minutes. Only the token's hash is stored.

const db = require("./lib/supabase");
const { newKey, hashKey } = require("./lib/keys");
const { siteUrl, sendMail, loginLinkMail } = require("./lib/mail");
const { json } = require("./lib/http");

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "Method Not Allowed" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return json(400, { error: "Invalid JSON body." }); }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email) || email.length > 254) return json(400, { error: "Invalid e-mail address." });
  const lang = body.lang === "ja" ? "ja" : "en";

  try {
    const token = newKey();
    const created = await db.rpc("create_login_token", { p_email: email, p_token_hash: hashKey(token) });
    if (created && created.email) {
      const link = `${siteUrl(event)}/?login=${token}${lang === "ja" ? "&lang=ja" : ""}`;
      const mail = loginLinkMail(lang, link);
      await sendMail({ to: created.email, subject: mail.subject, html: mail.html, text: mail.text });
    }
  } catch (err) {
    // Same answer as success: the page must not reveal anything. The problem is in the log.
    console.error("request-login-link failed", err.message);
  }
  return json(200, { ok: true });
};
