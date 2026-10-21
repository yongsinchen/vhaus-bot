// P1-6: the outbound Telegram send function, extracted so both server.js
// (the webhook process) and standalone scripts (e.g. the delivery-readiness
// reminder, run by a separate Railway cron service, never booting the
// Express app) share the exact same send behavior — including the
// Markdown-parse-failure fallback. Never duplicate this elsewhere.
const axios = require("axios");

function createTelegramSender({ token = process.env.TELEGRAM_BOT_TOKEN } = {}) {
  const TELEGRAM_API = `https://api.telegram.org/bot${token}`;

  async function sendMessage(chatId, text) {
    try {
      await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, parse_mode: "Markdown" });
    } catch (err) {
      console.error("sendMessage Markdown failed, retrying as plain text:", err.message);
      await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: text.replace(/[*_`]/g, "") });
    }
  }

  // For jobs that must not post twice (TG-02). Plain text only — no Markdown, so there is no
  // parse-failure fallback that could send a second copy. Resolves with Telegram's message_id
  // once Telegram confirmed the message; otherwise throws a TelegramSendError whose `outcome` is
  //   "failed"    — Telegram definitely did not take it (it answered with an error, or the
  //                 connection was never made): safe to send again;
  //   "uncertain" — it may have been delivered (timeout, connection dropped, 5xx, no message_id):
  //                 sending again risks a duplicate.
  async function sendMessageConfirmed(chatId, text, { timeoutMs = 15000 } = {}) {
    let res;
    try {
      res = await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text, disable_web_page_preview: true }, { timeout: timeoutMs });
    } catch (err) {
      throw classifyTelegramError(err);
    }
    const messageId = res?.data?.result?.message_id;
    if (res?.data?.ok !== true || !Number.isInteger(messageId)) {
      throw new TelegramSendError("uncertain", "Telegram answered without a message_id");
    }
    return { message_id: messageId };
  }

  return { sendMessage, sendMessageConfirmed };
}

class TelegramSendError extends Error {
  constructor(outcome, message, { status = null, retryAfter = null } = {}) {
    super(message);
    this.name = "TelegramSendError";
    this.outcome = outcome;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Connection never established → the request never reached Telegram.
const NOT_SENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ERR_INVALID_URL"]);

// Never puts the request URL (it contains the bot token) into the message.
function classifyTelegramError(err) {
  const status = err?.response?.status ?? null;
  if (status !== null) {
    const description = err.response.data?.description || `HTTP ${status}`;
    const retryAfter = err.response.data?.parameters?.retry_after ?? null;
    // Telegram answers 4xx only for a request it rejected; a 5xx gives no such guarantee.
    return new TelegramSendError(status < 500 ? "failed" : "uncertain", `Telegram ${status}: ${description}`, { status, retryAfter });
  }
  if (NOT_SENT_CODES.has(err?.code)) return new TelegramSendError("failed", `connection not established (${err.code})`);
  return new TelegramSendError("uncertain", `no response from Telegram (${err?.code || "unknown error"})`);
}

module.exports = { createTelegramSender, TelegramSendError, classifyTelegramError };
