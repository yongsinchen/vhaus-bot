require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

const app = express();

// ── CORS — must be before all routes ─────────────────────────────
app.use(cors({
  origin: ["https://vhaus-delivery.vercel.app", "http://localhost:3000"],
  methods: ["GET","POST","PATCH","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));
app.options("*", cors());
app.use(express.json());

// ── Clients ───────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // set this in your .env
const DELIVERY_GROUP_CHAT_ID = process.env.DELIVERY_GROUP_CHAT_ID; // Group B — drivers send delivery templates here

// ── In-memory pending drafts ──────────────────────────────────────
// Key: `${chatId}:${userId}` — each salesman has their own draft
const pendingOrders = new Map();

// ── Telegram Helpers ──────────────────────────────────────────────
const sendMessage = async (chatId, text) => {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    });
  } catch (err) {
    // Retry without Markdown if formatting caused the error
    console.error("sendMessage Markdown failed, retrying as plain text:", err.message);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: text.replace(/[*_`]/g, ""),
    });
  }
};

const getFileUrl = async (fileId) => {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = res.data.result.file_path;
  return `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
};

const downloadImageAsBase64 = async (url) => {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data).toString("base64");
};
const withTimeout = (promise, ms, message = "Request timeout") => {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    )
  ]);
};
// ── OpenAI Vision — Extract Sales Order ──────────────────────────
const extractOrderFromImage = async (base64Image) => {
const prompt = `You are a sales order OCR assistant for V Haus Living (PG) Sdn Bhd, a furniture company in Penang, Malaysia.

Extract all information from this handwritten sales order image.

Return ONLY valid JSON with no extra text, no markdown, no explanation.

Use this exact structure:
{
  "soNumber": "",
  "customerName": "",
  "address": "",
  "contact": "",
  "orderDate": "YYYY-MM-DD or empty",
  "salesman": "",
  "orderAmount": "",
  "balance": "",
  "deliveryDate": "YYYY-MM-DD, raw text, or empty",
  "originalDeliveryText": "",
  "needsDeliveryDateConfirmation": false,
  "timeSlot": "",
  "plateNo": "",
  "type": "Delivery",
  "serviceNote": "",
  "remark": "",
  "status": "Pending",
  "items": [
    {
      "itemCode": "",
      "itemName": "",
      "unit": "1",
      "supplier": "",
      "itemOrderDate": "",
      "supplierSentDate": "",
      "arrivalDate": ""
    }
  ]
}

General Rules:
- soNumber: look for "SALES ORDER:" or "SO:" number, usually a 5-digit number like 31073.
- customerName: look for "NAME:" field.
- address: look for "ADDRESS:" field. If it says "SAME WITH XXXXX", keep that text as-is.
- contact: look for "H/P NO:" or "TEL:" or "CONTACT:" field. Leave empty if not found.
- orderDate: look for "ORDER DATE:". Convert to YYYY-MM-DD. Example: 1/6/2026 = 2026-06-01. Leave empty if not found.
- salesman: look for "SALES ASSISTANT:" or "ORDER BY:" field.
- orderAmount: look for "TOTAL" amount, numeric only, no RM symbol. Example: 5590.
- balance: look for "BALANCE" amount, numeric only, no RM symbol. Example: 3891.
- items: extract ALL item rows from the DESCRIPTION column. Each numbered row (1., 2., 3.) is a separate item.
- Sub-items with "-" under a main item should be combined into one item description.
- For FOC items (free of charge), include them as separate items.
- itemCode: the product code if shown, e.g. 5023. Leave empty if not shown.
- itemName: full description of the item including sub-components.
- unit: quantity from QTY column, default "1" if not shown.
- remark: extract from "REMARKS:" section at the bottom.
- type: always "Delivery" unless the order says "SERVICE".
- status: always "Pending".
- If a field cannot be found, use empty string.

Delivery Date Rules:
- deliveryDate is very important.
- Look for "DELIVERY DATE:" field.

Rule 1: Exact Date
If delivery date is clearly written as a date, convert it to YYYY-MM-DD.

Examples:
- 3/6/2026 => 2026-06-03
- 03/06/2026 => 2026-06-03
- 3/6 => use same year as orderDate if available, otherwise current year.

Rule 2: Tomorrow
If delivery date contains:
- TMR
- Tomorrow
- Esok
- 明天

Then set deliveryDate = orderDate + 1 day.
Also set originalDeliveryText to the raw delivery date text.

Example:
orderDate = 2026-06-03
raw delivery date = TMR
deliveryDate = 2026-06-04
originalDeliveryText = TMR

Rule 3: ASAP
If delivery date contains:
- ASAP
- Urgent

Then set deliveryDate = orderDate + 21 days.
Also set originalDeliveryText to the raw delivery date text.

Example:
orderDate = 2026-06-03
raw delivery date = ASAP
deliveryDate = 2026-06-24
originalDeliveryText = ASAP

Rule 4: Month Only
If delivery date is only a month:

Examples:
- Aug
- August
- Sep
- Sept
- September
- Oct
- October
- Nov
- November
- Dec
- December

Use the middle of the month as guideline date.
Use day 15.

Examples:
- Sep => YYYY-09-15
- October => YYYY-10-15
- Nov => YYYY-11-15

Set originalDeliveryText to the raw delivery date text.

Rule 5: Month Range
If delivery date is a month range:

Examples:
- Aug - Sept
- Sep - Oct
- Oct - Nov
- August to September
- Aug/Sept

Use the earliest month in the range.
Use day 15.

Examples:
- Aug - Sept => YYYY-08-15
- Sep - Oct => YYYY-09-15
- Oct - Nov => YYYY-10-15

Set originalDeliveryText to the raw delivery date text.

Rule 6: Notes inside brackets
If delivery date contains extra notes inside brackets, only use the actual delivery instruction outside or at the start.

Examples:
- TMR (Fredrick T+7) => use TMR only, deliveryDate = orderDate + 1 day
- Tomorrow (call before go) => use Tomorrow only, deliveryDate = orderDate + 1 day
- ASAP (customer urgent) => use ASAP only, deliveryDate = orderDate + 21 days

Set originalDeliveryText to the full raw text.

Rule 7: Unclear Delivery Date
If delivery date cannot be confidently determined:
- unreadable handwriting
- unclear text
- partially covered
- invalid date
- confidence below 90%

Do NOT guess.

Set:
deliveryDate = ""
originalDeliveryText = raw delivery date text if visible, otherwise ""
needsDeliveryDateConfirmation = true

Rule 8: Empty Delivery Date
If the delivery date field is completely blank:

Set:
deliveryDate = ""
originalDeliveryText = ""
needsDeliveryDateConfirmation = true

Important:
- Do not invent a delivery date.
- If unsure, ask for confirmation by setting needsDeliveryDateConfirmation = true.
- Always return valid JSON only.`;

 const response = await withTimeout(
    openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: "high"
              }
            }
          ]
        }
      ]
    }),
    60000,
    "AI extraction timeout after 60 seconds"
  );

  console.log("OpenAI Vision response received.");

  const raw = response.choices?.[0]?.message?.content?.trim() || "";

  if (!raw) {
    throw new Error("AI returned empty response");
  }

  console.log("Raw AI response:", raw);

  const clean = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch (err) {
    console.error("JSON parse failed. Clean response:", clean);
    throw new Error("AI returned invalid JSON");
  }
};

// ── Parse Delivery Date from natural text ─────────────────────────
const parseDeliveryDate = (text) => {
  const today = new Date();
  const explicitDate = text.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (explicitDate) {
    const day = parseInt(explicitDate[1]);
    const month = parseInt(explicitDate[2]) - 1;
    const year = explicitDate[3]
      ? (explicitDate[3].length === 2 ? 2000 + parseInt(explicitDate[3]) : parseInt(explicitDate[3]))
      : today.getFullYear();
    const date = new Date(year, month, day);
    if (!isNaN(date.getTime())) return date.toISOString().split("T")[0];
  }
  const lower = text.toLowerCase();
  if (lower.includes("tmr") || lower.includes("tomorrow") || lower.includes("esok")) {
    const tmr = new Date(today); tmr.setDate(today.getDate() + 1); return tmr.toISOString().split("T")[0];
  }
  if (lower.includes("today") || lower.includes("hari ini")) return today.toISOString().split("T")[0];
  if (lower.includes("next week") || lower.includes("minggu depan")) {
    const nw = new Date(today); nw.setDate(today.getDate() + 7); return nw.toISOString().split("T")[0];
  }
  return null;
};

// ── Parse SO Update Message ───────────────────────────────────────
const parseUpdateMessage = (text) => {
  const soMatch = text.match(/SO\s*[:\-]?\s*(\S+)/i);
  const dateMatch = text.match(/DELIVERY\s*DATE\s*[:\-]?\s*(.+)/i);
  if (!soMatch || !dateMatch) return null;
  const soNumber = soMatch[1].trim();
  const dateText = dateMatch[1].trim();
  const deliveryDate = parseDeliveryDate(dateText);
  const lines = text.split("\n");
  const dateLineIdx = lines.findIndex(l => /DELIVERY\s*DATE/i.test(l));
  const remark = lines.slice(dateLineIdx + 1).join(" ").trim();
  return { soNumber, deliveryDate, dateText, remark };
};

// ── Normalize Delivery Date ───────────────────────────────────────
// Converts any raw delivery date text to a valid YYYY-MM-DD date (or null).
// Preserves original text in remark.
const normalizeDeliveryDate = (rawText, orderDate = null) => {
  if (!rawText || rawText.toString().trim() === "") {
    return { deliveryDate: null, originalDeliveryText: "", remarkNote: "" };
  }

  const raw = rawText.toString().trim();

  // Already ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { deliveryDate: raw, originalDeliveryText: raw, remarkNote: "" };
  }

  // ASAP → +21 days
  if (/^asap$/i.test(raw)) {
    const d = new Date();
    d.setDate(d.getDate() + 21);
    return {
      deliveryDate: d.toISOString().split("T")[0],
      originalDeliveryText: raw,
      remarkNote: "Original delivery date: ASAP",
    };
  }

  // Relative keywords: today, tomorrow, tmr, next week, esok etc.
  // Base date: use orderDate if available, otherwise today
  const lower0 = raw.toLowerCase();
  const relOffset = (
    /\b(today|hari ini)\b/.test(lower0) ? 0 :
    /\b(tomorrow|tmr|esok)\b/.test(lower0) ? 1 :
    /\b(next week|minggu depan)\b/.test(lower0) ? 7 :
    null
  );
  if (relOffset !== null) {
    const base = (orderDate && /^\d{4}-\d{2}-\d{2}$/.test(orderDate))
      ? new Date(orderDate + "T00:00:00")
      : new Date();
    base.setDate(base.getDate() + relOffset);
    const iso = base.toISOString().split("T")[0];
    return { deliveryDate: iso, originalDeliveryText: raw, remarkNote: "" };
  }

  // Exact date: d/m, d/m/yy, d/m/yyyy, d-m-yyyy etc.
  const exactMatch = raw.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/);
  if (exactMatch) {
    const day = parseInt(exactMatch[1]);
    const month = parseInt(exactMatch[2]) - 1;
    const rawYear = exactMatch[3];
    const year = rawYear
      ? (rawYear.length === 2 ? 2000 + parseInt(rawYear) : parseInt(rawYear))
      : new Date().getFullYear();
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) {
      return { deliveryDate: d.toISOString().split("T")[0], originalDeliveryText: raw, remarkNote: "" };
    }
  }

  // Month name / range / vague text → resolve to earliest guideline date
  const MONTHS = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5,
    jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
    // Chinese month abbreviations (8月 = aug, 9月 = sep etc.)
  };

  // Chinese month pattern e.g. "8月" or "9月"
  const chineseMonth = raw.match(/(\d{1,2})月/);
  if (chineseMonth) {
    const monthIdx = parseInt(chineseMonth[1]) - 1;
    return buildMonthResult(raw, monthIdx, "early");
  }

  const lower = raw.toLowerCase().replace(/[^a-z0-9\s\/-]/g, " ");

  // Determine qualifier: early / mid / end / late
  let qualifier = "early";
  if (/\b(end|late|akhir)\b/.test(lower)) qualifier = "end";
  else if (/\b(mid|middle|pertengahan)\b/.test(lower)) qualifier = "mid";
  else if (/\b(early|awal)\b/.test(lower)) qualifier = "early";

  // Extract first month name found (earliest in range)
  let foundMonth = null;
  for (const [name, idx] of Object.entries(MONTHS)) {
    const re = new RegExp("\\b" + name + "\\b");
    if (re.test(lower)) {
      if (foundMonth === null || idx < foundMonth) foundMonth = idx;
    }
  }

  if (foundMonth !== null) {
    return buildMonthResult(raw, foundMonth, qualifier);
  }

  // Cannot parse — return null, preserve raw in remark
  return {
    deliveryDate: null,
    originalDeliveryText: raw,
    remarkNote: `Original delivery date: ${raw}`,
  };
};

// Helper: build result for a resolved month + qualifier
const buildMonthResult = (raw, monthIdx, qualifier) => {
  const today = new Date();
  let year = today.getFullYear();
  // If this month has already passed this year, use next year
  if (monthIdx < today.getMonth()) year += 1;

  let day = 1;
  if (qualifier === "mid") day = 15;
  else if (qualifier === "end") day = 25;

  const d = new Date(year, monthIdx, day);
  return {
    deliveryDate: d.toISOString().split("T")[0],
    originalDeliveryText: raw,
    remarkNote: `Original delivery date: ${raw}`,
  };
};

// ── Build Order Preview ───────────────────────────────────────────
const buildOrderPreview = (data) => {
  const fmt = (v) => (v !== null && v !== undefined && v !== "" ? v : "-");
  const itemLines = (data.items || [])
    .map((item, i) => {
      const code = item.itemCode ? `[${item.itemCode}] ` : "";
      return `  ${i + 1}. ${code}${fmt(item.itemName)} x${fmt(item.unit)}`;
    })
    .join("\n");

  return (
    `📋 *Please confirm Sales Order*\n\n` +
    `SO: *${fmt(data.soNumber)}*\n` +
    `Customer: ${fmt(data.customerName)}\n` +
    `Contact: ${fmt(data.contact)}\n` +
    `Address: ${fmt(data.address)}\n` +
    `Order Date: ${fmt(data.orderDate)}\n` +
    `Delivery Date Guideline: ${fmt(data.deliveryDate)}\n` +
    (data.originalDeliveryText && data.originalDeliveryText !== data.deliveryDate
      ? `Original Delivery Text: ${data.originalDeliveryText}\n`
      : "") +
    `Time Slot: ${fmt(data.timeSlot)}\n` +
    `Salesman: ${fmt(data.salesman)}\n` +
    `Amount: RM${fmt(data.orderAmount)}\n` +
    `Balance: RM${fmt(data.balance)}\n` +
    `Type: ${fmt(data.type)}\n` +
    `Remark: ${fmt(data.remark)}\n` +
    (data.serviceNote ? `Service Note: ${fmt(data.serviceNote)}\n` : "") +
    (data.plateNo ? `Plate No: ${fmt(data.plateNo)}\n` : "") +
    `\n*Items:*\n` +
    (itemLines || "  (none)") +
    `\n\n_Reply:_\n` +
    `*YES* = save  |  *CANCEL* = discard\n` +
    `Or tell me what to change naturally.\n` +
    `_e.g. "delivery date is October", "balance is 3840", "item 2 is queen size", "remove item 3"_`
  );
};

// ── Parse key=value pairs from edit commands ──────────────────────
const parseKVPairs = (str) => {
  const result = {};
  const regex = /(\w+)=([^=]+?)(?=\s+\w+=|$)/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    result[match[1].trim()] = match[2].trim();
  }
  return result;
};

// ── Update Draft with Natural Language (GPT) ─────────────────────
const updateDraftWithNaturalLanguage = async (draft, correctionText) => {
  const prompt = `You are a sales order assistant. The user has reviewed an extracted sales order and wants to correct some fields.

Current order draft (JSON):
${JSON.stringify(draft, null, 2)}

User correction message:
"${correctionText}"

Apply the user's correction to the draft. Return ONLY the updated JSON object with no explanation, no markdown, no extra text.

Rules:
- Preserve ALL existing fields unless the user specifically changes them.
- For items: if user says "item 2 is X", update items[1]. If user says "remove item 3", remove items[2]. If user says "add item X", append to items array.
- For delivery date: store the user's natural language value as-is into deliveryDate (e.g. "October", "Aug - Sept", "ASAP", "3/6/2026"). Also update originalDeliveryText to match. The normalizeDeliveryDate function will handle ISO conversion before saving.
- For balance/amount: extract numeric value only, no RM symbol.
- For items added by user: use structure { itemName, unit, supplier, itemCode } — leave supplier and itemCode empty string if not mentioned.
- Return valid JSON only.`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 1000,
  });

  const raw = response.choices[0].message.content.trim();
  const clean = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(clean);
};

// ── Save Order to Supabase ────────────────────────────────────────
const saveOrderToSupabase = async (draft) => {
  // Normalize delivery date first
  const normalized = normalizeDeliveryDate(draft.deliveryDate, draft.orderDate);
  const deliveryDate = normalized.deliveryDate;

  const baseRemark = draft.remark || "";
  const finalRemark = normalized.remarkNote
    ? (baseRemark ? `${baseRemark} | ${normalized.remarkNote}` : normalized.remarkNote)
    : baseRemark || null;

  // ✅ Duplicate SO check AFTER declaring 'existing'
  const { data: existing } = await supabase
    .from("orders").select("id").eq("so_number", draft.soNumber).maybeSingle();

  if (existing) {
    return {
      ok: false,
      duplicate: true,
      msg:
        `❌ SO *${draft.soNumber}* already exists in the system.\n\n` +
        `This draft has been discarded automatically.\n` +
        `If this is a new order, please check the SO number and resend the photo.`
    };
  }

  const payload = {
    so_number: draft.soNumber || null,
    customer_name: draft.customerName || null,
    address: draft.address || null,
    contact: draft.contact || null,
    order_date: draft.orderDate || null,
    salesman: draft.salesman || null,
    order_amount: draft.orderAmount || null,
    balance: draft.balance || null,
    delivery_date: deliveryDate,
    time_slot: draft.timeSlot || null,
    plate_no: draft.plateNo || null,
    type: draft.type || "Delivery",
    service_note: draft.serviceNote || null,
    remark: finalRemark,
    status: "Pending",
    items: JSON.stringify(draft.items || []),
  };

  const { error } = await supabase.from("orders").insert(payload);
  if (error) return { ok: false, msg: `❌ Insert failed: ${error.message}` };

  const dateDisplay = deliveryDate || "Not set";
  const origNote = normalized.remarkNote ? `\n📝 _${normalized.remarkNote}_` : "";
  return {
    ok: true,
    msg: `✅ *Order Saved Successfully*\n\n📋 *SO:* ${draft.soNumber}\n👤 *Customer:* ${draft.customerName || "-"}\n📅 *Delivery Date:* ${dateDisplay}${origNote}\n\n_Order has been saved to the delivery sheet._`,
  };
};

// ── Handle Pending Draft Message ──────────────────────────────────
const handlePendingDraftMessage = async (chatId, userId, text) => {
  const draftKey = `${chatId}:${userId}`;
  const draft = pendingOrders.get(draftKey);
  if (!draft) return false; // no pending draft — caller handles normally

  const upper = text.trim().toUpperCase();

  // YES / CONFIRM / OK → save
  if (["YES", "CONFIRM", "OK"].includes(upper)) {
    const result = await saveOrderToSupabase(draft);
    if (result.ok) {
  pendingOrders.delete(draftKey);
  await sendMessage(chatId, result.msg);
} else if (result.duplicate) {
  pendingOrders.delete(draftKey);
  await sendMessage(chatId, result.msg);
} else {
  await sendMessage(
    chatId,
    result.msg + "\n\nDraft is still active. Make corrections and reply YES again."
  );
}
    return true;
  }

  // CANCEL → discard
  if (upper === "CANCEL") {
    pendingOrders.delete(draftKey);
    await sendMessage(chatId, "🗑 Order draft discarded.");
    return true;
  }

  // Natural language correction → send to GPT
  await sendMessage(chatId, "✏️ Updating draft...");
  try {
    const updatedDraft = await updateDraftWithNaturalLanguage(draft, text);
    pendingOrders.set(draftKey, updatedDraft);
    await sendMessage(chatId, buildOrderPreview(updatedDraft));
  } catch (err) {
    await sendMessage(chatId, `⚠️ Could not update draft: ${err.message}\nPlease try again or reply YES / CANCEL.`);
  }
  return true;
};

// ── Bot: /schedule command ────────────────────────────────────────
const handleScheduleCommand = async (chatId, text) => {
  const dateMatch = text.match(/\/schedule\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i);
  if (!dateMatch) { await sendMessage(chatId, "Usage: `/schedule 15/7` or `/schedule 2026-07-15`"); return; }
  const day = parseInt(dateMatch[1]);
  const month = parseInt(dateMatch[2]) - 1;
  const year = dateMatch[3]
    ? (dateMatch[3].length === 2 ? 2000 + parseInt(dateMatch[3]) : parseInt(dateMatch[3]))
    : new Date().getFullYear();
  const dateObj = new Date(year, month, day);
  const dateStr = dateObj.toISOString().split("T")[0];
  const dateLabel = dateObj.toLocaleDateString("en-MY", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const { data: orders, error } = await supabase.from("orders").select("*").eq("delivery_date", dateStr);
  if (error) { await sendMessage(chatId, `❌ Error: ${error.message}`); return; }
  if (!orders || orders.length === 0) { await sendMessage(chatId, `📅 No orders found for *${dateLabel}*`); return; }

  const grouped = {};
  orders.forEach(o => {
    const addr = (o.address || "").toUpperCase();
    let area = "OTHER";
    if (addr.includes("GEORGETOWN") || addr.includes("G.TOWN")) area = "GEORGETOWN";
    else if (addr.includes("BUKIT MERTAJAM") || addr.includes("BM")) area = "BUKIT MERTAJAM";
    else if (addr.includes("BUTTERWORTH")) area = "BUTTERWORTH";
    else if (addr.includes("KEPALA BATAS")) area = "KEPALA BATAS";
    else if (addr.includes("SIMPANG AMPAT")) area = "SIMPANG AMPAT";
    else if (addr.includes("NIBONG TEBAL")) area = "NIBONG TEBAL";
    else if (addr.includes("PERMATANG PAUH")) area = "PERMATANG PAUH";
    else if (addr.includes("SEBERANG JAYA")) area = "SEBERANG JAYA";
    if (!grouped[area]) grouped[area] = [];
    grouped[area].push(o);
  });

  let reply = `📦 *Delivery Schedule — ${dateLabel}*\nTotal: *${orders.length} orders*\n\n*Suggested grouping by area:*\n━━━━━━━━━━━━━━━━━━━━\n`;
  Object.entries(grouped).forEach(([area, areaOrders]) => {
    reply += `\n📍 *${area}* (${areaOrders.length} orders)\n`;
    areaOrders.forEach((o, i) => {
      const items = typeof o.items === "string" ? JSON.parse(o.items || "[]") : (o.items || []);
      const itemNames = items.map(it => it.itemName).filter(Boolean).join(", ");
      reply += `  ${i + 1}. SO *${o.so_number}* — ${o.customer_name || "-"}\n`;
      reply += `     📦 ${itemNames || "No items"}\n`;
      if (o.time_slot) reply += `     ⏰ ${o.time_slot}\n`;
      if (parseFloat(o.balance) > 0) reply += `     🔴 Balance: RM ${o.balance}\n`;
    });
  });
  reply += `\n━━━━━━━━━━━━━━━━━━━━\n_Open delivery sheet to assign lorries._`;
  await sendMessage(chatId, reply);
};

// ── Bot: /start and /help command ───────────────────────────────
const handleStartCommand = async (chatId, from) => {
  const name = from?.first_name || "there";
  await sendMessage(chatId,
    `👋 Hello ${name}! Welcome to *V Haus Living (PG) Bot*

` +
    `Here is what I can do:

` +
    `━━━━━━━━━━━━━━━━━━━━
` +
    `📷 *Submit a Sales Order*
` +
    `Send me a photo of the handwritten sales order.
` +
    `I will extract all details and show you a preview.
` +
    `Reply *YES* to save, *CANCEL* to discard,
` +
    `or tell me what to correct naturally.

` +
    `_e.g. "balance is 3840", "delivery date is 10/6"_

` +
    `━━━━━━━━━━━━━━━━━━━━
` +
    `📅 *Update Delivery Date*
` +
    `Send a message in this format:
` +
    `SO: 31074
` +
    `DELIVERY DATE: 10/6
` +
    `optional remark here

` +
    `━━━━━━━━━━━━━━━━━━━━
` +
    `🚨 *Flag a Wrong Order*
` +
    `If you saved an order with wrong info:
` +
    `/flag 31074 balance should be 3840

` +
    `━━━━━━━━━━━━━━━━━━━━
` +
    `🗓 *Check Delivery Schedule*
` +
    `/schedule 15/6

` +
    `━━━━━━━━━━━━━━━━━━━━
` +
    `Type /help anytime to see this menu again.`
  );
};

// ── Bot: /flag command ────────────────────────────────────────────
const handleFlagCommand = async (chatId, text, from) => {
  // Usage: /flag 31074 balance should be 3840 not 1650
  const match = text.match(/\/flag\s+(\S+)\s+([\s\S]+)/i);
  if (!match) {
    await sendMessage(chatId,
      "⚠️ *How to flag an order:*\n\n" +
      "`/flag <SO Number> <what is wrong>`\n\n" +
      "*Examples:*\n" +
      "`/flag 31074 balance should be 3840 not 1650`\n" +
      "`/flag 31074 wrong customer name, should be Rebecca Tan`\n" +
      "`/flag 31074 delivery date should be 15/6 not 10/6`"
    );
    return;
  }

  const soNumber = match[1].trim();
  const flagNote = match[2].trim();
  const salesmanName = from?.first_name
    ? (from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name)
    : (from?.username || "Unknown");

  // Find the order
  const { data: order, error: findErr } = await supabase
    .from("orders")
    .select("id, so_number, customer_name, status, remark, delivery_date")
    .eq("so_number", soNumber)
    .maybeSingle();

  if (findErr) {
    await sendMessage(chatId, `❌ Database error: ${findErr.message}`);
    return;
  }
  if (!order) {
    await sendMessage(chatId,
      `❌ SO *${soNumber}* not found in the system.\n` +
      `Please check the SO number and try again.`
    );
    return;
  }

  // Build updated remark — append flag note with timestamp
  const now = new Date().toLocaleString("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
  const flagEntry = `⚠️ FLAGGED by ${salesmanName} (${now}): ${flagNote}`;
  const updatedRemark = order.remark
    ? `${order.remark} | ${flagEntry}`
    : flagEntry;

  // Update order: status → Flagged, remark → append flag note
  const { error: updateErr } = await supabase
    .from("orders")
    .update({ status: "Flagged", remark: updatedRemark })
    .eq("so_number", soNumber);

  if (updateErr) {
    await sendMessage(chatId, `❌ Failed to flag SO *${soNumber}*: ${updateErr.message}`);
    return;
  }

  // Confirm to salesman
  await sendMessage(chatId,
    `✅ *SO ${soNumber} has been flagged*\n\n` +
    `👤 Customer: ${order.customer_name || "-"}\n` +
    `📝 Issue: ${flagNote}\n\n` +
    `_Admin has been notified and will correct it in the delivery sheet._`
  );

  // Notify admin group
  if (ADMIN_CHAT_ID) {
    await sendMessage(ADMIN_CHAT_ID,
      `🚨 *Order Flagged — Action Required*\n\n` +
      `📋 *SO:* ${soNumber}\n` +
      `👤 *Customer:* ${order.customer_name || "-"}\n` +
      `📅 *Delivery Date:* ${order.delivery_date || "-"}\n\n` +
      `⚠️ *Issue reported by ${salesmanName}:*\n` +
      `_${flagNote}_\n\n` +
      `Please correct this order in the delivery sheet.\n` +
      `🔗 https://vhaus-delivery.vercel.app`
    );
  }
};


// ── Get Next SV Number ────────────────────────────────────────────
const getNextSvNumber = async () => {
  const { data, error } = await supabase
    .from("orders")
    .select("sv_number")
    .not("sv_number", "is", null)
    .order("sv_number", { ascending: false })
    .limit(1);
  if (error || !data || data.length === 0) return "SV-001";
  const last = data[0].sv_number; // e.g. "SV-007"
  const num = parseInt(last.replace("SV-", "")) + 1;
  return `SV-${String(num).padStart(3, "0")}`;
};

// ── Parse Delivery Template from Group B ─────────────────────────
const parseDeliveryTemplate = (text) => {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const get = (key) => {
    const line = lines.find(l => l.toLowerCase().startsWith(key.toLowerCase() + ":"));
    return line ? line.substring(line.indexOf(":") + 1).trim() : null;
  };

  const driver = get("Driver");
  const helper = get("Kelindan");
  const soRaw  = get("SO");
  const statusRaw = get("Status");

  if (!driver || !soRaw || !statusRaw) return null;

  // Parse date — look for a line matching d/m/yyyy or d/m/yy or d/m
  let date = null;
  for (const line of lines) {
    const m = line.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/);
    if (m) {
      const day = parseInt(m[1]);
      const month = parseInt(m[2]) - 1;
      const year = m[3]
        ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]))
        : new Date().getFullYear();
      date = new Date(year, month, day).toISOString().split("T")[0];
      break;
    }
  }

  // Note — any line that is not a known key and not the date line
  const knownPrefixes = ["driver", "kelindan", "so", "status"];
  const noteLines = lines.filter(l => {
    const lower = l.toLowerCase();
    if (knownPrefixes.some(k => lower.startsWith(k + ":"))) return false;
    if (/^\d{1,2}[\/-]\d{1,2}/.test(l)) return false;
    return true;
  });
  const note = noteLines.join(" ").trim() || null;

  const soNumber = soRaw.toString().trim();
  const isSettle = /settle/i.test(statusRaw) && !/no|not/i.test(statusRaw);

  return { driver, helper, soNumber, date, note, isSettle, statusRaw };
};

// ── Handle Delivery Group Template ────────────────────────────────
const handleDeliveryTemplate = async (chatId, text) => {
  const parsed = parseDeliveryTemplate(text);
  if (!parsed) return false; // not a template — ignore

  const { driver, helper, soNumber, date, note, isSettle, statusRaw } = parsed;

  // Find the order in DB
  const { data: order, error: findErr } = await supabase
    .from("orders")
    .select("id, so_number, customer_name, remark, status, delivery_date")
    .eq("so_number", soNumber)
    .maybeSingle();

  if (findErr) {
    await sendMessage(chatId, `❌ Database error: ${findErr.message}`);
    return true;
  }
  if (!order) {
    await sendMessage(chatId, `❌ SO *${soNumber}* not found in system.\nPlease check the SO number.`);
    return true;
  }

  // Build remark note with driver/helper info
  const now = new Date().toLocaleString("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
  const driverNote = `Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""} (${now})`;
  const updatedRemark = order.remark
    ? `${order.remark} | ${driverNote}`
    : driverNote;

  if (isSettle) {
    // ── SETTLE: mark order as Delivered ──────────────────────────
    const { error: updateErr } = await supabase
      .from("orders")
      .update({ status: "Delivered", remark: updatedRemark })
      .eq("so_number", soNumber);

    if (updateErr) {
      await sendMessage(chatId, `❌ Failed to update SO *${soNumber}*: ${updateErr.message}`);
      return true;
    }

    await sendMessage(chatId,
      `✅ *SO ${soNumber} — Settled*\n\n` +
      `👤 Customer: ${order.customer_name || "-"}\n` +
      `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
      `📅 Date: ${date || "-"}\n\n` +
      `_Order marked as Delivered._`
    );

    if (ADMIN_CHAT_ID) {
      await sendMessage(ADMIN_CHAT_ID,
        `✅ *Delivery Settled*\n\n` +
        `📋 SO: ${soNumber} | 👤 ${order.customer_name || "-"}\n` +
        `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
        `📅 Date: ${date || "-"}`
      );
    }

  } else {
    // ── NO SETTLE: create service_pending record ──────────────────
    const { error: spErr } = await supabase
      .from("service_pending")
      .insert({
        so_number: soNumber,
        driver,
        helper: helper || null,
        date: date || null,
        note: note || null,
        status: "Pending"
      });

    if (spErr) {
      await sendMessage(chatId, `❌ Failed to create service pending for SO *${soNumber}*: ${spErr.message}`);
      return true;
    }

    // Also append driver/helper + note to order remark
    const fullRemark = note
      ? `${updatedRemark} | Issue: ${note}`
      : updatedRemark;
    await supabase.from("orders").update({ remark: fullRemark }).eq("so_number", soNumber);

    await sendMessage(chatId,
      `⚠️ *SO ${soNumber} — Not Settled*\n\n` +
      `👤 Customer: ${order.customer_name || "-"}\n` +
      `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
      `📅 Date: ${date || "-"}\n` +
      (note ? `📝 Note: ${note}\n` : "") +
      `\n_Service Pending created. Admin has been notified._`
    );

    if (ADMIN_CHAT_ID) {
      await sendMessage(ADMIN_CHAT_ID,
        `🔧 *Service Pending — Action Required*\n\n` +
        `📋 SO: *${soNumber}* | 👤 ${order.customer_name || "-"}\n` +
        `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
        `📅 Date: ${date || "-"}\n` +
        (note ? `📝 Issue: ${note}\n` : "") +
        `\nCheck Service Pending tab to convert or remove.\n` +
        `🔗 https://vhaus-delivery.vercel.app`
      );
    }
  }

  return true;
};

// ── Delivery Vehicle API ──────────────────────────────────────────

// GET /delivery/vehicles
app.get("/delivery/vehicles", async (req, res) => {
  const { data, error } = await supabase
    .from("delivery_vehicles")
    .select("*")
    .order("created_at");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /delivery/vehicles
app.post("/delivery/vehicles", async (req, res) => {
  const { driver_name, vehicle_plate, vehicle_type, status } = req.body;
  if (!driver_name && !vehicle_plate) return res.status(400).json({ error: "driver_name or vehicle_plate is required" });
  const { data, error } = await supabase
    .from("delivery_vehicles")
    .insert({ driver_name, vehicle_plate, vehicle_type, status: status || "Active" })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /delivery/vehicles/:id
app.patch("/delivery/vehicles/:id", async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from("delivery_vehicles")
    .update(req.body)
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /delivery/vehicles/:id
app.delete("/delivery/vehicles/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("delivery_vehicles").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Delivery Routes API ───────────────────────────────────────────


// GET /delivery/routes?date=2026-07-15
app.get("/delivery/routes", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });
  const { data: routes, error: routeErr } = await supabase
    .from("delivery_routes").select("*").eq("delivery_date", date).order("created_at");
  if (routeErr) return res.status(500).json({ error: routeErr.message });
  const routesWithOrders = await Promise.all(routes.map(async (route) => {
    const { data: routeOrders } = await supabase
      .from("delivery_route_orders")
      .select("*, orders(*)")
      .eq("route_id", route.id)
      .order("sequence_no");
    return { ...route, orders: routeOrders || [] };
  }));
  res.json(routesWithOrders);
});


// GET /delivery/unassigned?date=2026-07-15
app.get("/delivery/unassigned", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });
  const { data: orders, error: ordErr } = await supabase.from("orders").select("*").eq("delivery_date", date);
  if (ordErr) return res.status(500).json({ error: ordErr.message });
  const { data: assigned } = await supabase
    .from("delivery_route_orders")
    .select("order_id, delivery_routes!inner(delivery_date)")
    .eq("delivery_routes.delivery_date", date);
  const assignedIds = new Set((assigned || []).map(a => a.order_id));
  res.json((orders || []).filter(o => !assignedIds.has(o.id)));
}); 

// POST /delivery/routes — with duplicate vehicle validation
app.post("/delivery/routes", async (req, res) => {
  const { delivery_date, lorry_plate, driver_name, area, notes, vehicle_id } = req.body;
  if (!delivery_date) return res.status(400).json({ error: "delivery_date is required" });

  if (vehicle_id) {
    const { data: existing } = await supabase
      .from("delivery_routes").select("id")
      .eq("delivery_date", delivery_date).eq("vehicle_id", vehicle_id).maybeSingle();
    if (existing) return res.status(409).json({ error: "This vehicle already has a route for this date." });
  } else if (lorry_plate) {
    const { data: existing } = await supabase
      .from("delivery_routes").select("id")
      .eq("delivery_date", delivery_date).eq("lorry_plate", lorry_plate).maybeSingle();
    if (existing) return res.status(409).json({ error: "This vehicle already has a route for this date." });
  }

  const { data, error } = await supabase
    .from("delivery_routes")
    .insert({ delivery_date, lorry_plate, driver_name, area, notes, status: "Pending", ...(vehicle_id && { vehicle_id }) })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Helper — Malaysia local date
const getMalaysiaDate = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());

// PATCH /delivery/routes/:id
app.patch("/delivery/routes/:id", async (req, res) => {
  const { id } = req.params;

  const { data: current } = await supabase.from("delivery_routes").select("status, delivery_date").eq("id", id).single();
  const isLocked = current?.status === "Out for Delivery" || current?.status === "Delivered";

  if (isLocked) {
    const keys = Object.keys(req.body);
    const onlyStatus = keys.length === 1 && keys[0] === "status";
    const validTransition = req.body.status === "Delivered" || req.body.status === "Out for Delivery";
    if (!onlyStatus || !validTransition) {
      return res.status(403).json({ error: "Route is locked. Only status update is allowed." });
    }
  }

  if (req.body.status === "Out for Delivery") {
    const today = getMalaysiaDate();
    if (current?.delivery_date !== today) {
      return res.status(403).json({ error: "Route can only be marked Out for Delivery on the delivery date." });
    }
  }

  const { data, error } = await supabase
    .from("delivery_routes").update(req.body).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  if (req.body.status === "Out for Delivery" || req.body.status === "Delivered") {
    const { data: routeOrders } = await supabase
      .from("delivery_route_orders").select("order_id").eq("route_id", id);
    if (routeOrders && routeOrders.length > 0) {
      const orderIds = routeOrders.map(ro => ro.order_id);
      const orderStatus = req.body.status === "Delivered" ? "Delivered" : "Out for Delivery";
      await supabase.from("orders").update({ status: orderStatus }).in("id", orderIds);
    }
  }

  res.json(data);
});

// DELETE /delivery/routes/:id
app.delete("/delivery/routes/:id", async (req, res) => {
  const { id } = req.params;
  const { data: current } = await supabase.from("delivery_routes").select("status").eq("id", id).single();
  if (current?.status === "Out for Delivery" || current?.status === "Delivered") {
    return res.status(403).json({ error: "Route is locked and cannot be deleted." });
  }
  const { error } = await supabase.from("delivery_routes").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Delivery Route Orders API ─────────────────────────────────────

// POST /delivery/routes/:routeId/orders
app.post("/delivery/routes/:routeId/orders", async (req, res) => {
  const { routeId } = req.params;
  const { order_id, sequence_no, scheduled_time_range, route_note } = req.body;

  // Lock check
  const { data: route } = await supabase.from("delivery_routes").select("status").eq("id", routeId).single();
  if (route?.status === "Out for Delivery" || route?.status === "Delivered") {
    return res.status(403).json({ error: "Route is locked. Cannot add orders." });
  }

  const { data, error } = await supabase
    .from("delivery_route_orders")
    .insert({ route_id: routeId, order_id, sequence_no: sequence_no || 1,
      ...(scheduled_time_range && { scheduled_time_range }),
      ...(route_note && { route_note }) })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});


// PATCH /delivery/routes/:routeId/orders/:orderId
app.patch("/delivery/routes/:routeId/orders/:orderId", async (req, res) => {
  const { routeId, orderId } = req.params;
  const { sequence_no, scheduled_time_range, route_note } = req.body;

  // Lock check
  const { data: route } = await supabase.from("delivery_routes").select("status").eq("id", routeId).single();
  if (route?.status === "Out for Delivery" || route?.status === "Delivered") {
    return res.status(403).json({ error: "Route is locked. Cannot update orders." });
  }

  const updates = {};
  if (sequence_no !== undefined) updates.sequence_no = sequence_no;
  if (scheduled_time_range !== undefined) updates.scheduled_time_range = scheduled_time_range;
  if (route_note !== undefined) updates.route_note = route_note;

  const { data, error } = await supabase
    .from("delivery_route_orders")
    .update(updates).eq("route_id", routeId).eq("order_id", orderId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Sync orders.time_slot when scheduled_time_range is saved
  if (scheduled_time_range !== undefined) {
    await supabase.from("orders").update({ time_slot: scheduled_time_range }).eq("id", orderId);
  }

  res.json(data);
});

// DELETE /delivery/routes/:routeId/orders/:orderId
app.delete("/delivery/routes/:routeId/orders/:orderId", async (req, res) => {
  const { routeId, orderId } = req.params;

  // Lock check
  const { data: route } = await supabase.from("delivery_routes").select("status").eq("id", routeId).single();
  if (route?.status === "Out for Delivery" || route?.status === "Delivered") {
    return res.status(403).json({ error: "Route is locked. Cannot remove orders." });
  }

  const { error } = await supabase
    .from("delivery_route_orders").delete().eq("route_id", routeId).eq("order_id", orderId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Service Pending API ──────────────────────────────────────────

// GET /service-pending
app.get("/service-pending", async (req, res) => {
  const { data, error } = await supabase
    .from("service_pending")
    .select("*")
    .eq("status", "Pending")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /service-pending/:id/convert — convert to Service order
app.post("/service-pending/:id/convert", async (req, res) => {
  const { id } = req.params;
  const { remark: adminRemark } = req.body || {};

  const { data: sp, error: spErr } = await supabase
    .from("service_pending").select("*").eq("id", id).single();
  if (spErr || !sp) return res.status(404).json({ error: "Service pending not found" });

  // Get original order for customer details
  const { data: order } = await supabase
    .from("orders").select("*").eq("so_number", sp.so_number).maybeSingle();

  // Get next SV number
  const svNumber = await getNextSvNumber();

  // Build service note
  const serviceNote = `${sp.so_number}${sp.note ? ` — ${sp.note}` : ""}`;

  // Build remark combining driver info + admin remark
  const remarkParts = [
    `Converted from Service Pending`,
    `Driver: ${sp.driver}${sp.helper ? ` | Helper: ${sp.helper}` : ""}`,
    sp.note ? `Issue: ${sp.note}` : null,
    adminRemark ? `Admin note: ${adminRemark}` : null,
  ].filter(Boolean);

  // Create new Service order
  const payload = {
    so_number: sp.so_number,
    sv_number: svNumber,
    customer_name: order?.customer_name || null,
    address: order?.address || null,
    contact: order?.contact || null,
    salesman: order?.salesman || null,
    order_amount: order?.order_amount || null,
    balance: order?.balance || null,
    type: "Service",
    service_note: serviceNote,
    remark: remarkParts.join(" | "),
    status: "Pending",
    items: order?.items || "[]",
    delivery_date: null,
  };

  const { data: newOrder, error: insertErr } = await supabase
    .from("orders").insert(payload).select().single();
  if (insertErr) return res.status(500).json({ error: insertErr.message });

  // Mark service_pending as Converted
  await supabase.from("service_pending").update({ status: "Converted" }).eq("id", id);

  res.json({ success: true, svNumber, order: newOrder });
});

// DELETE /service-pending/:id — remove (not applicable)
app.delete("/service-pending/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("service_pending").update({ status: "Removed" }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Telegram Webhook ──────────────────────────────────────────────
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.message;
    if (!message) return;
    const chatId = message.chat.id;
    const userId = message.from?.id;
    const draftKey = `${chatId}:${userId}`;

    // ── Group B: Delivery template messages ───────────────────────
    if (String(chatId) === String(DELIVERY_GROUP_CHAT_ID)) {
      if (message.text) {
        await handleDeliveryTemplate(chatId, message.text);
      }
      return;
    }

    // ── Text messages ─────────────────────────────────────────────
    if (message.text) {
      // Pending draft exists — route ALL text to confirmation handler first
      if (pendingOrders.has(draftKey)) {
        await handlePendingDraftMessage(chatId, userId, message.text);
        return;
      }

      // No pending draft — existing flows unchanged
      if (message.text.startsWith("/start") || message.text.startsWith("/help")) {
        await handleStartCommand(chatId, message.from);
        return;
      }

      if (message.text.startsWith("/schedule")) {
        await handleScheduleCommand(chatId, message.text);
        return;
      }

      if (message.text.startsWith("/flag")) {
        await handleFlagCommand(chatId, message.text, message.from);
        return;
      }

      // Existing delivery date update logic
      const parsed = parseUpdateMessage(message.text);
      if (!parsed) return;
      const { soNumber, deliveryDate, dateText, remark } = parsed;
      const { data: existing, error: findErr } = await supabase
        .from("orders").select("id, so_number, customer_name, delivery_date, remark")
        .eq("so_number", soNumber).maybeSingle();
      if (findErr) { await sendMessage(chatId, `❌ Database error: ${findErr.message}`); return; }
      if (!existing) { await sendMessage(chatId, `❌ SO *${soNumber}* not found in the system.`); return; }
      if (!deliveryDate) {
        await sendMessage(chatId, `⚠️ Could not understand delivery date: *"${dateText}"*\nPlease use format like: \`2/6\` or \`tmr\` or \`3/6/2026\``);
        return;
      }
      const updatedRemark = remark ? `${existing.remark ? existing.remark + " | " : ""}${remark}` : existing.remark;
      const { error: updateErr } = await supabase
        .from("orders")
        .update({ delivery_date: deliveryDate, ...(updatedRemark && { remark: updatedRemark }) })
        .eq("so_number", soNumber);
      if (updateErr) { await sendMessage(chatId, `❌ Failed to update SO *${soNumber}*\nError: ${updateErr.message}`); return; }
      const formattedDate = new Date(deliveryDate).toLocaleDateString("en-MY", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
      await sendMessage(chatId,
        `✅ *Delivery Date Updated*\n\n📋 *SO:* ${soNumber}\n👤 *Customer:* ${existing.customer_name || "-"}\n📅 *New Delivery Date:* ${formattedDate}\n📝 *Date Input:* "${dateText}"\n${remark ? `💬 *Remark:* ${remark}\n` : ""}\n_Delivery sheet has been updated._`
      );
      return;
    }

    // ── Photo messages — create pending draft, do NOT insert yet ──
    if (!message.photo || message.photo.length === 0) return;
    await sendMessage(chatId, "📷 Processing sales order image...");
    const photo = message.photo[message.photo.length - 1];
    const fileUrl = await getFileUrl(photo.file_id);
    const base64Image = await downloadImageAsBase64(fileUrl);
    await sendMessage(chatId, "🔍 Extracting order details with AI...");

    let data;
try {
  console.log("Calling extractOrderFromImage...");
  data = await extractOrderFromImage(base64Image);
  console.log("Extraction success:", data);
} catch (err) {
  console.error("Extraction failed:", err);

  await sendMessage(
    chatId,
    `❌ AI extraction failed.\n\n` +
    `Reason: ${err.message}\n\n` +
    `Please resend a clearer photo or try again later.`
  );

  return;
}

    if (!data.soNumber) {
      await sendMessage(chatId, "❌ Could not find SO Number in the image. Please try again with a clearer image.");
      return;
    }

    // Normalize delivery date immediately after extraction
    const normalized = normalizeDeliveryDate(data.deliveryDate, data.orderDate);
    data.deliveryDate = normalized.deliveryDate;
    data.originalDeliveryText = normalized.originalDeliveryText;
    // Pre-populate remark note into draft so salesman can see it
    if (normalized.remarkNote) {
      data.remark = data.remark
        ? `${data.remark} | ${normalized.remarkNote}`
        : normalized.remarkNote;
    }

    // Store as pending draft — NO Supabase insert yet
    pendingOrders.set(draftKey, data);

    // Send preview and ask for confirmation
    await sendMessage(chatId, buildOrderPreview(data));

  } catch (err) {
    console.error("Webhook error:", err);
  }
});

// ── Health Check ──────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", message: "V Haus Telegram Bot Server" }));

// ── Start Server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));