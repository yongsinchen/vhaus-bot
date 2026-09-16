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

  return { sendMessage };
}

module.exports = { createTelegramSender };
