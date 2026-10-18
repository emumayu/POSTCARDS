// netlify/functions/lib/receipt.js
//
// sendReceiptOnce(row, event) — the purchase confirmation e-mail, sent exactly once per purchase.
//   Called from verify-session (buyer is back from Stripe) AND from the Stripe Webhook (buyer closed the tab).
//   Whoever comes first claims purchases.receipt_sent_at with a single conditional UPDATE; the other one sees
//   it is already claimed and does nothing. If sending fails the claim is released so the next call retries.
//   The e-mail has a MY TRIPS login link (same one-time link as request-login-link) when the customer is still
//   under the link limit; otherwise it just points to the site.
//
//   -> { sent: true }  mailed now      { already: true }  mailed (or being mailed) before
//      { sent: false, error }  failed (logged)      { sent: false }  nothing to send (not paid / no e-mail)

const db = require("./supabase");
const { newKey, hashKey } = require("./keys");
const { siteUrl, sendMail, receiptMail } = require("./mail");

const maskEmail = (e) => {
  const [local, domain] = String(e || "").split("@");
  if (!local || !domain) return "";
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
};

async function sendReceiptOnce(row, event) {
  if (!row || row.status !== "paid" || !row.email) return { sent: false };

  const claimed = await db.update(
    `purchases?id=eq.${encodeURIComponent(row.id)}&receipt_sent_at=is.null`,
    { receipt_sent_at: new Date().toISOString() }
  );
  if (!Array.isArray(claimed) || !claimed.length) return { sent: false, already: true };

  try {
    const lang = row.region === "intl" ? "en" : "ja";
    const base = siteUrl(event, row.site_origin);
    const token = newKey();
    const made = await db.rpc("create_login_token", { p_email: row.email, p_token_hash: hashKey(token) });
    const withLogin = !!(made && made.email);
    const link = withLogin ? `${base}/?login=${token}${lang === "ja" ? "&lang=ja" : ""}` : `${base}/${lang === "ja" ? "?lang=ja" : ""}`;
    const mail = receiptMail(lang, { plan: row.plan_type, days: row.days, city: row.city, currency: row.currency, amount_total: row.amount_total }, link, withLogin);
    await sendMail({ to: row.email, subject: mail.subject, html: mail.html, text: mail.text });
    return { sent: true };
  } catch (err) {
    console.error("receipt mail failed", row.id, err.message);
    try { await db.update(`purchases?id=eq.${encodeURIComponent(row.id)}`, { receipt_sent_at: null }); }
    catch (e2) { console.error("receipt claim could not be released", row.id, e2.message); }
    return { sent: false, error: err.message };
  }
}

module.exports = { sendReceiptOnce, maskEmail };
