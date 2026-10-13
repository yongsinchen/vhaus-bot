#!/usr/bin/env node
/**
 * Registers the Telegram webhook WITH a secret_token, so POST /telegram/webhook can refuse forged
 * updates (lib/telegram-webhook-auth.js). Telegram then sends the secret on every update as the
 * X-Telegram-Bot-Api-Secret-Token header.
 *
 * Needs TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET (the same values the server runs with).
 * The webhook URL defaults to the one currently registered; pass --url to change it.
 * allowed_updates is not sent, so Telegram keeps its current setting; pending updates are kept.
 *
 * Zero-downtime order:
 *   1. deploy the server code (with TELEGRAM_WEBHOOK_SECRET still unset it accepts every update),
 *   2. run this script with --apply (Telegram starts sending the header; the server ignores it),
 *   3. set TELEGRAM_WEBHOOK_SECRET on the server (it now refuses updates without the header).
 *
 * Usage:
 *   node scripts/set-telegram-webhook.js                 (show current webhook + what would change; no change)
 *   node scripts/set-telegram-webhook.js --apply         (register the current URL with the secret)
 *   node scripts/set-telegram-webhook.js --apply --url https://…/telegram/webhook
 */
require("dotenv").config();
const axios = require("axios");
const { isValidWebhookSecret } = require("../lib/telegram-webhook-auth");

const APPLY = process.argv.includes("--apply");
const urlArg = (() => { const i = process.argv.indexOf("--url"); return i > -1 ? process.argv[i + 1] : null; })();

(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token) { console.error("TELEGRAM_BOT_TOKEN is not set."); process.exit(1); }
  if (!isValidWebhookSecret(secret)) {
    console.error("TELEGRAM_WEBHOOK_SECRET is missing or invalid (1–256 chars of A-Z a-z 0-9 _ -).");
    console.error("Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    process.exit(1);
  }
  const api = `https://api.telegram.org/bot${token}`;

  const { data: info } = await axios.get(`${api}/getWebhookInfo`);
  const current = info.result || {};
  console.log("Current webhook:");
  console.log(`  url:                  ${current.url || "(none — bot is not on a webhook)"}`);
  console.log(`  pending_update_count: ${current.pending_update_count ?? "-"}`);
  if (current.last_error_message) console.log(`  last_error:           ${current.last_error_message} (${new Date(current.last_error_date * 1000).toISOString()})`);

  const url = urlArg || current.url;
  if (!url || !/^https:\/\//.test(url)) { console.error("\nNo https webhook URL to register — pass --url https://…/telegram/webhook"); process.exit(1); }

  if (!APPLY) {
    console.log(`\nWould register ${url} with the secret token. Re-run with --apply to do it.`);
    return;
  }
  const { data } = await axios.post(`${api}/setWebhook`, { url, secret_token: secret });
  if (!data.ok) { console.error("setWebhook failed:", data.description); process.exit(1); }
  console.log(`\n✅ Registered ${url} with the secret token.`);
  console.log("Now set TELEGRAM_WEBHOOK_SECRET on the server (same value) so it starts refusing unsigned updates.");
})().catch(e => {
  // axios errors carry the request URL, which contains the bot token — print only Telegram's answer.
  console.error("Failed:", e.response?.data?.description || e.code || "request error");
  process.exit(1);
});
