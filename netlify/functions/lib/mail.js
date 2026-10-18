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

// An origin is accepted only if it is one of this project's own hosts.
function safeOrigin(v) {
  try {
    const u = new URL(String(v || ""));
    if (u.protocol === "https:" && SELF_HOST.test(u.hostname)) return u.origin;
  } catch { /* not a URL */ }
  return null;
}

// Base URL for links in e-mails: SITE_URL, else `preferred` (the site the buyer paid on), else the request's
// Origin, else the production site — the last three only when they are this project's own hosts.
function siteUrl(event, preferred) {
  const fixed = (process.env.SITE_URL || "").trim().replace(/\/+$/, "");
  if (fixed) return fixed;
  const origin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || "";
  return safeOrigin(preferred) || safeOrigin(origin) || "https://postcardsguide.com";
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

const CONTACT = "hello@postcardsguide.com";

// The "open my trips" e-mail. lang: "ja" | "en".
function loginLinkMail(lang, link) {
  const ja = lang === "ja";
  const subject = ja ? "POSTCARDS：旅程を開くリンク" : "POSTCARDS: your link to open your trips";
  const lines = ja
    ? ["POSTCARDSをご利用いただきありがとうございます。", "下のリンクから、購入した旅程とリストを、この端末で開けます。", "リンクは15分間、1回だけ使えます。", "このメールに心当たりがない場合は、何もせず破棄してください。", `ご不明な点は ${CONTACT} までご連絡ください。`]
    : ["Thank you for using POSTCARDS.", "Use the link below to open your trips and lists on this device.", "The link works once and expires in 15 minutes.", "If you didn't ask for this, you can ignore this e-mail.", `Questions? Write to ${CONTACT}.`];
  const button = ja ? "旅程を開く" : "Open my trips";
  const text = `${lines.join("\n\n")}\n\n${link}\n`;
  const html = `<div style="font-family:Helvetica,Arial,'Hiragino Sans','Noto Sans JP',sans-serif;color:#2b2a22;max-width:480px;margin:0 auto;padding:24px">
<p style="font-size:12px;letter-spacing:.18em;color:#5e5d52;margin:0 0 20px">POSTCARDS</p>
<p style="line-height:1.7">${esc(lines[0])}<br>${esc(lines[1])}</p>
<p style="margin:28px 0"><a href="${esc(link)}" style="background:#45412f;color:#f1f1ee;text-decoration:none;padding:14px 28px;font-size:13px;letter-spacing:.14em">${esc(button)}</a></p>
<p style="font-size:13px;color:#5e5d52;line-height:1.7">${esc(lines[2])}<br>${esc(lines[3])}<br>${esc(lines[4])}</p>
<p style="font-size:12px;color:#8a897f;word-break:break-all">${esc(link)}</p></div>`;
  return { subject, html, text };
}

const CITY_JA = { Tokyo: "東京", Kyoto: "京都", Osaka: "大阪", Nagano: "長野", Yamanashi: "山梨", Kamakura: "鎌倉" };

function money(currency, minor) {
  const n = Number(minor) || 0;
  if (currency === "jpy") return `¥${n.toLocaleString("en-US")}`;
  if (currency === "usd") return `$${(n / 100).toFixed(2)}`;
  return `${String(currency || "").toUpperCase()} ${(n / 100).toFixed(2)}`;
}

const planName = (plan, days) => (plan === "day" ? "1 DAY PLAN" : plan === "full" ? `FULL PLAN · ${days} DAYS` : "FULL LIST");

// Purchase confirmation. p: { plan, days, city, currency, amount_total }; link: where the button goes;
// withLogin: the link signs the buyer in (otherwise it just opens the site).
function receiptMail(lang, p, link, withLogin) {
  const ja = lang === "ja";
  const city = (ja && CITY_JA[p.city]) || p.city || "";
  const rows = [
    [ja ? "プラン" : "Plan", planName(p.plan, p.days)],
    ...(city ? [[ja ? "エリア" : "Area", city]] : []),
    [ja ? "お支払い金額" : "Amount", money(p.currency, p.amount_total)],
  ];
  const subject = ja ? "POSTCARDS：ご購入ありがとうございます" : "POSTCARDS: thank you for your purchase";
  const intro = ja ? "ご購入ありがとうございます。お支払いを確認しました。" : "Thank you for your purchase. Your payment is confirmed.";
  const how = withLogin
    ? (ja ? "下のボタンから、購入したプランを開けます（リンクは15分間、1回だけ有効です）。旅程づくりの続きも、できあがった旅程の見直しも、ここからできます。あとから別の端末で開くときは、サイトの MY TRIPS でメールアドレスを入力してください。"
          : "Use the button below to open your plan (the link works once and expires in 15 minutes). You can continue building your itinerary or look it over again from there. To open it later on another device, enter your e-mail in MY TRIPS on the site.")
    : (ja ? "購入したプランは、サイトの MY TRIPS からいつでも開けます。別の端末では、MY TRIPS でこのメールアドレスを入力してください。"
          : "Your plan is always available in MY TRIPS on the site. On another device, enter this e-mail address in MY TRIPS.");
  const button = withLogin ? (ja ? "プランを開く" : "Open my plan") : (ja ? "POSTCARDSを開く" : "Open POSTCARDS");
  const contact = ja ? `ご不明な点は ${CONTACT} までご連絡ください。` : `Questions? Write to ${CONTACT}.`;

  const text = `${intro}\n\n${rows.map((r) => `${r[0]}: ${r[1]}`).join("\n")}\n\n${how}\n\n${link}\n\n${contact}\n`;
  const html = `<div style="font-family:Helvetica,Arial,'Hiragino Sans','Noto Sans JP',sans-serif;color:#2b2a22;max-width:480px;margin:0 auto;padding:24px">
<p style="font-size:12px;letter-spacing:.18em;color:#5e5d52;margin:0 0 20px">POSTCARDS</p>
<p style="line-height:1.7">${esc(intro)}</p>
<table style="border-collapse:collapse;margin:18px 0;width:100%">${rows.map((r) => `<tr><td style="padding:8px 0;border-top:1px solid #c8c7c0;font-size:12px;color:#5e5d52;width:38%">${esc(r[0])}</td><td style="padding:8px 0;border-top:1px solid #c8c7c0;font-size:14px">${esc(r[1])}</td></tr>`).join("")}<tr><td colspan="2" style="border-top:1px solid #c8c7c0"></td></tr></table>
<p style="font-size:13px;color:#5e5d52;line-height:1.7">${esc(how)}</p>
<p style="margin:26px 0"><a href="${esc(link)}" style="background:#45412f;color:#f1f1ee;text-decoration:none;padding:14px 28px;font-size:13px;letter-spacing:.14em">${esc(button)}</a></p>
<p style="font-size:13px;color:#5e5d52;line-height:1.7">${esc(contact)}</p></div>`;
  return { subject, html, text };
}

module.exports = { siteUrl, safeOrigin, sendMail, loginLinkMail, receiptMail };
