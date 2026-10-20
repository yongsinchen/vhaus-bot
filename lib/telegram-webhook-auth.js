// Telegram webhook authenticity.
//
// POST /telegram/webhook is a public URL. Telegram does not sign updates, so without a check anyone who
// knows the URL can post a forged update carrying a registered user's from.id (not a secret) and act as
// that user — /approve, reschedule, delivery reports in the delivery group.
//
// setWebhook's secret_token is echoed back by Telegram on every update as the
// X-Telegram-Bot-Api-Secret-Token header. With TELEGRAM_WEBHOOK_SECRET set, an update whose header does not
// match is refused before anything is read. Register it with scripts/set-telegram-webhook.js.
const crypto = require("crypto");

const SECRET_HEADER = "x-telegram-bot-api-secret-token";
// Telegram's own rule for secret_token: 1–256 characters, A-Z a-z 0-9 _ -
const VALID_SECRET = /^[A-Za-z0-9_-]{1,256}$/;

function isValidWebhookSecret(secret) {
  return typeof secret === "string" && VALID_SECRET.test(secret);
}

// secret unset → enforcement off (returns true); the caller warns at startup.
function isTelegramWebhookAuthorized(headerValue, secret) {
  if (!secret) return true;
  if (typeof headerValue !== "string") return false;
  const a = Buffer.from(headerValue), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { SECRET_HEADER, isValidWebhookSecret, isTelegramWebhookAuthorized };
