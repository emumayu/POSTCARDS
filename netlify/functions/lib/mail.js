// netlify/functions/lib/mail.js
//
// Sends e-mail through Resend's HTTP API (no extra package).
//   RESEND_API_KEY  re_...                                   (Netlify, scope: Functions)
//   MAIL_FROM       POSTCARDS <noreply@postcardsguide.com>   (an address on the verified Resend domain)
//   SITE_URL        https://postcardsguide.com               (optional: base of the links in e-mails)
//
// Links in e-mails never use the request's Origin as is (a forged Origin would send the buyer's login
// link to another site). siteUrl() uses SITE_URL, or an Origin on this project's own hosts only.

const SELF_HOST = /^(www\.)?postcardsguide\.com$|^(?:[a-z0-9-]+--)?postcardsguide\.netlify\.app$/i;

function siteUrl(event) {
  const fixed = (process.env.SITE_URL || "").trim().replace(/\/+$/, "");
  if (fixed) return fixed;
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || "";
  try {
    const u = new URL(origin);
    if (u.protocol === "https:" && SELF_HOST.test(u.hostname)) return u.origin;
  } catch { /* fall through */ }
  return "https://postcardsguide.com";
}

async function sendMail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) {
    const err = new Error("Resend is not configured (RESEND_API_KEY / MAIL_FROM).");
    err.code = "CONFIG";
    throw err;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend failed (${res.status}): ${body}`.slice(0, 300));
  }
  return res.json().catch(() => ({}));
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// The "open my trips" e-mail. lang: "ja" | "en".
function loginLinkMail(lang, link) {
  const ja = lang === "ja";
  const subject = ja ? "POSTCARDS：旅程を開くリンク" : "POSTCARDS: your link to open your trips";
  const lines = ja
    ? ["POSTCARDSをご利用いただきありがとうございます。", "下のリンクから、購入した旅程とリストを、この端末で開けます。", "リンクは15分間、1回だけ使えます。", "このメールに心当たりがない場合は、何もせず破棄してください。"]
    : ["Thank you for using POSTCARDS.", "Use the link below to open your trips and lists on this device.", "The link works once and expires in 15 minutes.", "If you didn't ask for this, you can ignore this e-mail."];
  const button = ja ? "旅程を開く" : "Open my trips";
  const text = `${lines.join("\n\n")}\n\n${link}\n`;
  const html = `<div style="font-family:Helvetica,Arial,'Hiragino Sans','Noto Sans JP',sans-serif;color:#2b2a22;max-width:480px;margin:0 auto;padding:24px">
<p style="font-size:12px;letter-spacing:.18em;color:#5e5d52;margin:0 0 20px">POSTCARDS</p>
<p style="line-height:1.7">${esc(lines[0])}<br>${esc(lines[1])}</p>
<p style="margin:28px 0"><a href="${esc(link)}" style="background:#45412f;color:#f1f1ee;text-decoration:none;padding:14px 28px;font-size:13px;letter-spacing:.14em">${esc(button)}</a></p>
<p style="font-size:13px;color:#5e5d52;line-height:1.7">${esc(lines[2])}<br>${esc(lines[3])}</p>
<p style="font-size:12px;color:#8a897f;word-break:break-all">${esc(link)}</p></div>`;
  return { subject, html, text };
}

module.exports = { siteUrl, sendMail, loginLinkMail };
