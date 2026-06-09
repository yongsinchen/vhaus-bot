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
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const DELIVERY_GROUP_CHAT_ID = process.env.DELIVERY_GROUP_CHAT_ID;
const DO_GROUP_CHAT_ID = process.env.DO_GROUP_CHAT_ID; // Group C — warehouse snaps supplier DOs
const OPERATION_MANAGER_ID = "1725894161"; // Only OM can approve/reject reschedule requests

// ── Telegram user lookup ─────────────────────────────────────────
const getTelegramUser = async (telegramId) => {
  const { data } = await supabase
    .from("users")
    .select("*, companies(id, name, code)")
    .eq("telegram_id", String(telegramId))
    .eq("is_active", true)
    .single();
  return data || null;
};

// ── Working days helper ───────────────────────────────────────────
const getNextWorkingDays = (n, fromDate = null) => {
  const days = [];
  const d = fromDate ? new Date(fromDate + "T00:00:00+08:00") : new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  while (days.length < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0) { // skip Sunday only — Saturday is a working day
      days.push(d.toISOString().split("T")[0]);
    }
  }
  return days;
};

const isWithinWorkingDays = (dateStr, n = 2) => {
  const blocked = getNextWorkingDays(n);
  return blocked.includes(dateStr);
};

// ── Pending reschedule approvals ─────────────────────────────────
// Key: soNumber — stores pending approval details
const pendingApprovals = new Map();

// ── Session State Manager ────────────────────────────────────────
// Replaces simple pendingOrders map with full guided session system
// Session shape: { mode, step, data, expiresAt }
// Modes: "new_order", "reschedule", "flag"
// Steps vary per mode

const sessions = new Map();

const TIMEOUTS = {
  new_order: 30 * 60 * 1000,  // 30 minutes (extended for multi-order sessions)
  reschedule: 5 * 60 * 1000,  // 5 minutes
  flag: 5 * 60 * 1000,        // 5 minutes
};

const WARDROBE_KEYWORDS = [
  "wardrobe", "wardrob", "almari", "almeria",
  "衣橱", "衣柜", "衣櫃",
  "full fitting", "full set fitting", "full-fitting",
  "customize", "custom", "customized",
  "fitting", "install", "installation",
];

const hasWardrobeItem = (items = []) => {
  return items.some(item => {
    const name = (item.itemName || "").toLowerCase();
    return WARDROBE_KEYWORDS.some(kw => name.includes(kw.toLowerCase()));
  });
};

const setSession = (key, mode, step, data = {}) => {
  const timeout = TIMEOUTS[mode] || 5 * 60 * 1000;
  sessions.set(key, { mode, step, data, expiresAt: Date.now() + timeout });
};

const getSession = (key) => {
  const s = sessions.get(key);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(key); return null; }
  return s;
};

const clearSession = (key) => sessions.delete(key);

// Backwards compatibility — pendingOrders is now sessions in new_order mode
const pendingOrders = { has: (k) => { const s = getSession(k); return s?.mode === "new_order" && s?.step === "confirm"; }, get: (k) => getSession(k)?.data?.draft, set: () => {} };

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

  // TBC / TBD / unknown → store as null, note in remark
  if (/^(tbc|tbd|unknown|belum tahu|belum|pending date)$/i.test(raw)) {
    return {
      deliveryDate: null,
      originalDeliveryText: raw,
      remarkNote: `Delivery date: ${raw.toUpperCase()}`,
    };
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
    is_multi_trip: draft.isMultiTrip || false,
    planned_trips: draft.plannedTrips || 1,
    company_id: draft.companyId || null,
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
      // Loop back — ready for next order photo
      setSession(draftKey, "new_order", "waiting_photo", {});
      await sendMessage(chatId, "📷 Send the next sales order photo, or type *cancel* to stop.");
    } else if (result.duplicate) {
      pendingOrders.delete(draftKey);
      await sendMessage(chatId, result.msg);
    } else {
      await sendMessage(chatId, result.msg + "\n\nDraft is still active. Make corrections and reply YES again.");
    }
    return true;
  }

  // CANCEL → discard
  if (upper === "CANCEL") {
    pendingOrders.delete(draftKey);
    clearSession(draftKey);
    await showMenu(chatId, "🗑 Order draft discarded.");
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

// ── Handle /approve and /reject commands (OM only) ───────────────
const handleApprovalCommand = async (chatId, userId, text) => {
  if (String(userId) !== OPERATION_MANAGER_ID) {
    await sendMessage(chatId, "❌ Only the Operation Manager can approve or reject reschedule requests.");
    return;
  }

  const isApprove = text.startsWith("/approve");
  const soNumber = text.split(/\s+/)[1]?.trim();
  if (!soNumber) {
    await sendMessage(chatId, `Usage: /${isApprove ? "approve" : "reject"} <SO Number>
Example: /${isApprove ? "approve" : "reject"} 11576`);
    return;
  }

  const approval = pendingApprovals.get(soNumber);
  if (!approval) {
    await sendMessage(chatId, `❌ No pending reschedule request found for SO *${soNumber}*.`);
    return;
  }

  pendingApprovals.delete(soNumber);

  if (isApprove) {
    // Apply the reschedule
    const { isTrip, tripId, tripNo, orderId, newDate, customerName, salesmanName } = approval;
    if (isTrip) {
      await supabase.from("order_trips").update({ scheduled_date: newDate }).eq("id", tripId);
      if (tripNo === 1) await supabase.from("orders").update({ delivery_date: newDate }).eq("so_number", soNumber);
    } else {
      await supabase.from("orders").update({ delivery_date: newDate }).eq("id", orderId);
    }
    await sendMessage(chatId, `✅ *Approved*\n\nSO *${soNumber}*${isTrip ? ` Trip ${tripNo}` : ""} rescheduled to *${fmtDate(newDate)}*.`);
    // Notify salesman
    if (approval.salesmanChatId) {
      await sendMessage(approval.salesmanChatId,
        `✅ *Reschedule Approved*\n\nYour request to reschedule SO *${soNumber}* to *${fmtDate(newDate)}* has been approved by the Operation Manager.`
      );
    }
  } else {
    await sendMessage(chatId, `❌ *Rejected*\n\nReschedule request for SO *${soNumber}* has been rejected.`);
    if (approval.salesmanChatId) {
      await sendMessage(approval.salesmanChatId,
        `❌ *Reschedule Rejected*\n\nYour request to reschedule SO *${soNumber}* to *${fmtDate(approval.newDate)}* was rejected by the Operation Manager.\n\nPlease contact admin for alternative arrangements.`
      );
    }
  }
};

// ── Show Main Menu ───────────────────────────────────────────────
const showMenu = async (chatId, intro = "") => {
  const lines = [
    intro || null,
    "🏠 *PulseOS Bot*",
    "",
    "What would you like to do?",
    "",
    "1\u{31}\u{FE0F}\u{20E3} New Order",
    "2\u{32}\u{FE0F}\u{20E3} Reschedule",
    "3\u{33}\u{FE0F}\u{20E3} Flag Wrong Order",
    "4\u{34}\u{FE0F}\u{20E3} Help",
    "",
    "_Reply with a number or keyword_",
  ].filter(l => l !== null);
  await sendMessage(chatId, lines.join("\n"));
};

// ── Parse date helper ─────────────────────────────────────────────
const parseDateInput = (text) => {
  const t = text.trim();
  // TBC / TBD → return special marker
  if (/^(tbc|tbd|unknown|belum)$/i.test(t)) return "TBC";
  const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m) {
    const day = parseInt(m[1]);
    const month = parseInt(m[2]) - 1;
    const year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3])) : new Date().getFullYear();
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  }
  const lower = t.toLowerCase();
  const today = new Date();
  if (/^(today|hari ini)$/.test(lower)) return today.toISOString().split("T")[0];
  if (/^(tmr|tomorrow|esok)$/.test(lower)) { today.setDate(today.getDate()+1); return today.toISOString().split("T")[0]; }
  return null;
};

const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-MY", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "-";

// ── Create order trips ────────────────────────────────────────────
const createTrips = async (soNumber, svNumber, totalTrips, deliveryDate = null) => {
  const trips = Array.from({ length: totalTrips }, (_, i) => ({
    so_number: soNumber,
    sv_number: svNumber,
    trip_no: i + 1,
    total_trips: totalTrips,
    status: "Scheduled",
    // Trip 1 inherits the original delivery date from the sales order
    scheduled_date: i === 0 ? (deliveryDate || null) : null,
  }));
  const { error } = await supabase.from("order_trips").insert(trips);
  return error;
};

// ── Handle session input (guided menu router) ─────────────────────
const handleSession = async (chatId, userId, text, from) => {
  const key = `${chatId}:${userId}`;
  const session = getSession(key);

  // ── NEW ORDER flow ────────────────────────────────────────────
  if (session?.mode === "new_order") {

    // step: waiting_photo — only accept photo (handled in photo section)
    if (session.step === "waiting_photo") {
      await sendMessage(chatId, "📷 Please send me the sales order photo, or type *cancel* to go back to the menu.");
      return true;
    }

    // step: waiting_trips — salesman answered how many trips
    if (session.step === "waiting_trips") {
      if (text.toLowerCase() === "cancel") { clearSession(key); await showMenu(chatId, "Cancelled."); return true; }
      const trips = parseInt(text.trim());
      if (isNaN(trips) || trips < 1 || trips > 10) {
        await sendMessage(chatId, "⚠️ Please enter a number between 1 and 10.");
        return true;
      }
      const draft = session.data.draft;
      draft.plannedTrips = trips;
      draft.isMultiTrip = trips > 1;
      setSession(key, "new_order", "confirm", { draft });
      await sendMessage(chatId, buildOrderPreview(draft));
      return true;
    }

    // step: confirm — YES/CANCEL/correction
    if (session.step === "confirm") {
      const draft = session.data.draft;
      const upper = text.trim().toUpperCase();

      if (upper === "CANCEL") {
        clearSession(key);
        await showMenu(chatId, "🗑 Order draft discarded.");
        return true;
      }

      if (["YES", "CONFIRM", "OK"].includes(upper)) {
        const result = await saveOrderToSupabase(draft);
        if (result.ok) {
          // Create trips if multi-trip
          if (draft.isMultiTrip && draft.plannedTrips > 1) {
            const svNumber = await getNextSvNumber();
            const tripErr = await createTrips(draft.soNumber, svNumber, draft.plannedTrips, draft.deliveryDate || null);
            if (!tripErr) {
              await sendMessage(chatId,
                `${result.msg}\n\n🔄 *${draft.plannedTrips} trips pre-scheduled* (SV: ${svNumber})\n_Admin can assign dates in the delivery schedule._`
              );
            } else {
              await sendMessage(chatId, result.msg + "\n⚠️ Could not create trips: " + tripErr.message);
            }
          } else {
            await sendMessage(chatId, result.msg);
          }
          // Loop back — ready for next order without needing to type 1 again
          setSession(key, "new_order", "waiting_photo", {});
          await sendMessage(chatId, "📷 Send the next sales order photo, or type *cancel* to stop.");
        } else if (result.duplicate) {
          clearSession(key);
          await sendMessage(chatId, result.msg);
        } else {
          await sendMessage(chatId, result.msg + "\n\nDraft still active. Correct and reply YES again.");
        }
        return true;
      }

      // Natural language correction
      await sendMessage(chatId, "✏️ Updating draft...");
      try {
        const updated = await updateDraftWithNaturalLanguage(draft, text);
        setSession(key, "new_order", "confirm", { draft: updated });
        await sendMessage(chatId, buildOrderPreview(updated));
      } catch (err) {
        await sendMessage(chatId, `⚠️ Could not update: ${err.message}
Reply YES / CANCEL or correct again.`);
      }
      return true;
    }
  }

  // ── RESCHEDULE flow ───────────────────────────────────────────
  if (session?.mode === "reschedule") {

    if (text.toLowerCase() === "cancel") { clearSession(key); await showMenu(chatId, "Cancelled."); return true; }

    // step: waiting_so — waiting for SO + optional trip number
    if (session.step === "waiting_so") {
      const tripMatch = text.match(/(\d+)\s+(?:trip\s*)?(\d+)/i);
      const soOnly = text.match(/^(\d+)$/);
      const soNumber = tripMatch ? tripMatch[1] : (soOnly ? soOnly[1] : text.trim());
      const tripNo = tripMatch ? parseInt(tripMatch[2]) : null;

      if (tripNo) {
        const { data: trip } = await supabase
          .from("order_trips").select("*")
          .eq("so_number", soNumber).eq("trip_no", tripNo).maybeSingle();
        if (!trip) {
          await sendMessage(chatId, `❌ Trip ${tripNo} for SO *${soNumber}* not found.\nPlease check and try again.`);
          return true;
        }
        if (trip.status === "Completed" || trip.status === "Cancelled") {
          await sendMessage(chatId, `❌ Trip ${tripNo} is already *${trip.status}* and cannot be rescheduled.`);
          return true;
        }
        setSession(key, "reschedule", "waiting_date", { soNumber, tripNo, tripId: trip.id, currentDate: trip.scheduled_date, isTrip: true });
        await sendMessage(chatId,
          `📋 *SO ${soNumber} — Trip ${tripNo} of ${trip.total_trips}*\n` +
          `📅 Currently scheduled: *${fmtDate(trip.scheduled_date)}*\n\n` +
          `What is the new date?\n_e.g. 5/3, 5/3/2026, tmr, TBC_`
        );
      } else {
        // Find order — check both Delivery and Service types
        const { data: order } = await supabase
          .from("orders").select("id, so_number, customer_name, delivery_date, type")
          .eq("so_number", soNumber).in("type", ["Delivery", "Service"]).maybeSingle();
        if (!order) {
          await sendMessage(chatId, `❌ SO *${soNumber}* not found.\nPlease check and try again.`);
          return true;
        }
        const label = order.type === "Service" ? "🔧 Service" : "🚚 Delivery";
        setSession(key, "reschedule", "waiting_date", { soNumber, orderId: order.id, currentDate: order.delivery_date, customerName: order.customer_name, isTrip: false });
        await sendMessage(chatId,
          `📋 *SO ${soNumber}* — ${order.customer_name || ""} _(${label})_\n` +
          `📅 Currently scheduled: *${fmtDate(order.delivery_date)}*\n\n` +
          `What is the new date?\n_e.g. 5/3, 5/3/2026, tmr, TBC_`
        );
      }
      return true;
    }


     // step: waiting_date
     if (session.step === "waiting_date") {
       const newDate = parseDateInput(text);
       if (!newDate) {
         await sendMessage(chatId, `⚠️ Could not understand date: "${text}"\nPlease use format like: 5/3, 5/3/2026, tmr, or TBC`);
         return true;
       }

       const { soNumber, tripNo, tripId, orderId, currentDate, customerName, isTrip } = session.data;
       const isTbc = newDate === "TBC";
       const dbDate = isTbc ? null : newDate;
       const displayDate = isTbc ? "TBC (no date set)" : fmtDate(newDate);

       // ── 2-working-day rule check ──────────────────────────────
       if (!isTbc && isWithinWorkingDays(newDate, 2)) {
         // Check if date has a Confirmed route
         const { data: confirmedRoutes } = await supabase
           .from("delivery_routes")
           .select("id, lorry_plate, driver_name")
           .eq("delivery_date", newDate)
           .eq("status", "Confirmed");

         if (confirmedRoutes && confirmedRoutes.length > 0) {
           const salesmanName = from?.first_name
             ? (from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name)
             : (from?.username || "Unknown");

           // Store pending approval
           pendingApprovals.set(soNumber, {
             isTrip, tripId, tripNo, orderId, newDate,
             soNumber, customerName, salesmanName,
             salesmanChatId: chatId,
           });

           clearSession(key);

           // Tell salesman request is pending
           await sendMessage(chatId,
             `⚠️ *Approval Required*\n\n` +
             `${fmtDate(newDate)} is within the next 2 working days and already has a *Confirmed* route.\n\n` +
             `Your reschedule request for SO *${soNumber}* has been sent to the Operation Manager for approval.\n\n` +
             `_You will be notified once approved or rejected._`
           );

           // Notify Operation Manager
           const routeInfo = confirmedRoutes.map(r => `${r.lorry_plate || ""} ${r.driver_name || ""}`.trim()).join(", ");
           await sendMessage(OPERATION_MANAGER_ID,
             `🔔 *Reschedule Approval Needed*\n\n` +
             `👤 Salesman: ${salesmanName}\n` +
             `📋 SO: *${soNumber}*${customerName ? ` — ${customerName}` : ""}\n` +
             (isTrip ? `🔄 Trip ${tripNo}\n` : "") +
             `📅 Requested date: *${fmtDate(newDate)}*\n\n` +
             `⚠️ This date already has a Confirmed route: ${routeInfo}\n\n` +
             `Reply:\n` +
             `✅ /approve ${soNumber} — to approve\n` +
             `❌ /reject ${soNumber} — to reject`
           );
           return true;
         }
       }

       // No confirmed route conflict — apply directly
       if (isTrip) {
         const updatePayload = { scheduled_date: dbDate };
         if (isTbc) updatePayload.status = "Scheduled";
         const { error } = await supabase.from("order_trips").update(updatePayload).eq("id", tripId);
         if (error) { await sendMessage(chatId, `❌ Failed to update: ${error.message}`); return true; }
         if (tripNo === 1) {
           await supabase.from("orders").update({ delivery_date: dbDate }).eq("so_number", soNumber);
         }
         clearSession(key);
         await sendMessage(chatId,
           `✅ *Trip ${isTbc ? "Set to TBC" : "Rescheduled"}*\n\n` +
           `📋 SO: ${soNumber} — Trip ${tripNo}\n` +
           `📅 Old date: ${fmtDate(currentDate)}\n` +
           `📅 New date: *${displayDate}*\n\n` +
           (tripNo === 1 ? `_Delivery date on order updated to match._\n` : "") +
           `_Delivery schedule has been updated._`
         );
       } else {
         const { data: existingOrder } = await supabase.from("orders").select("remark").eq("id", orderId).single();
         const updatedRemark = isTbc && existingOrder
           ? (existingOrder.remark ? `${existingOrder.remark} | Delivery date: TBC` : "Delivery date: TBC")
           : existingOrder?.remark;
         const { error } = await supabase.from("orders").update({
           delivery_date: dbDate,
           ...(isTbc && { remark: updatedRemark })
         }).eq("id", orderId);
         if (error) { await sendMessage(chatId, `❌ Failed to update: ${error.message}`); return true; }
         clearSession(key);
         await sendMessage(chatId,
           `✅ *Delivery Date ${isTbc ? "Set to TBC" : "Updated"}*\n\n` +
           `📋 SO: ${soNumber}${customerName ? ` — ${customerName}` : ""}\n` +
           `📅 Old date: ${fmtDate(currentDate)}\n` +
           `📅 New date: *${displayDate}*\n\n` +
           `_Delivery schedule has been updated._`
         );
       }
       return true;
     }
   }


  // ── FLAG flow ─────────────────────────────────────────────────
  if (session?.mode === "flag") {

    if (text.toLowerCase() === "cancel") { clearSession(key); await showMenu(chatId, "Cancelled."); return true; }

    // step: waiting_so
    if (session.step === "waiting_so") {
      const soNumber = text.trim();
      const { data: order } = await supabase
        .from("orders").select("id, so_number, customer_name, status")
        .eq("so_number", soNumber).eq("type", "Delivery").maybeSingle();
      if (!order) {
        await sendMessage(chatId, `❌ SO *${soNumber}* not found.
Please check and try again, or type *cancel*.`);
        return true;
      }
      setSession(key, "flag", "waiting_issue", { soNumber, orderId: order.id, customerName: order.customer_name });
      await sendMessage(chatId,
        `📋 *SO ${soNumber}* — ${order.customer_name || ""}

What is wrong with this order?`
      );
      return true;
    }

    // step: waiting_issue
    if (session.step === "waiting_issue") {
      const { soNumber, orderId, customerName } = session.data;
      const issue = text.trim();
      const salesmanName = from?.first_name ? (from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name) : (from?.username || "Unknown");
      const now = new Date().toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
      const flagEntry = `⚠️ FLAGGED by ${salesmanName} (${now}): ${issue}`;

      const { data: order } = await supabase.from("orders").select("remark").eq("id", orderId).single();
      const updatedRemark = order?.remark ? `${order.remark} | ${flagEntry}` : flagEntry;

      const { error } = await supabase.from("orders").update({ status: "Flagged", remark: updatedRemark }).eq("id", orderId);
      if (error) { await sendMessage(chatId, `❌ Failed to flag: ${error.message}`); return true; }

      clearSession(key);
      await sendMessage(chatId, `✅ *SO ${soNumber} has been flagged*

📝 Issue: ${issue}

_Admin has been notified._`);

      if (ADMIN_CHAT_ID) {
        await sendMessage(ADMIN_CHAT_ID,
          `🚨 *Order Flagged — Action Required*

` +
          `📋 SO: *${soNumber}* | 👤 ${customerName || "-"}
` +
          `⚠️ Issue by ${salesmanName}: ${issue}

` +
          `🔗 https://vhaus-delivery.vercel.app`
        );
      }
      return true;
    }
  }

  return false; // no active session matched
};

// ── Bot: /start and /help command ───────────────────────────────
const handleStartCommand = async (chatId, from) => {
  const name = from?.first_name || "there";
  const lines = [
    `👋 Hello ${name}! Welcome to *PulseOS Bot*`,
    ``,
    `Reply with a number to get started:`,
    ``,
    `1️⃣ *New Order* — Send a sales order photo`,
    `2️⃣ *Reschedule* — Change a delivery or service date`,
    `3️⃣ *Flag Wrong Order* — Report incorrect order info`,
    `4️⃣ *Help* — Show this menu`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📷 *1 — New Order*`,
    `Select 1, then send the sales order photo.`,
    `Bot extracts all details → you confirm or correct.`,
    `If wardrobe/fitting detected → bot asks how many trips.`,
    ``,
    `📅 *2 — Reschedule*`,
    `Select 2, then enter the SO number.`,
    `For multi-trip: enter SO + trip number e.g. _11576 Trip 2_`,
    `Bot shows current date → you enter new date.`,
    `Accepted formats: 5/3, 5/3/2026, tmr, TBC`,
    ``,
    `🚨 *3 — Flag Wrong Order*`,
    `Select 3, enter SO number, then describe the issue.`,
    `Admin will be notified to fix it.`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `_Type /help anytime to see this menu._`,
    `_Type cancel anytime to go back._`,
  ];
  await sendMessage(chatId, lines.join("\n"));
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
  // Check both orders and order_trips tables since SV numbers exist in both
  const [ordersRes, tripsRes] = await Promise.all([
    supabase.from("orders").select("sv_number").not("sv_number", "is", null).order("sv_number", { ascending: false }).limit(1),
    supabase.from("order_trips").select("sv_number").not("sv_number", "is", null).order("sv_number", { ascending: false }).limit(1),
  ]);

  const allSvNumbers = [
    ...(ordersRes.data || []).map(r => r.sv_number),
    ...(tripsRes.data || []).map(r => r.sv_number),
  ].filter(Boolean);

  if (allSvNumbers.length === 0) return "SV-001";

  // Find the highest SV number across both tables
  const maxNum = Math.max(...allSvNumbers.map(sv => parseInt(sv.replace("SV-", "")) || 0));
  return `SV-${String(maxNum + 1).padStart(3, "0")}`;
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
  if (!text.trim().toUpperCase().startsWith("DELIVERY")) return false;
  const parsed = parseDeliveryTemplate(text);
  if (!parsed) {
    await sendMessage(chatId,
      "⚠️ *Could not read the delivery report.*\n\n" +
      "Please use this exact format:\n\n" +
      "```\n" +
      "DELIVERY\n" +
      "SO: 11576\n" +
      "Driver: Seng\n" +
      "Kelindan: San\n" +
      "Status: settle\n" +
      "9/6/2026\n" +
      "optional note here\n" +
      "```\n\n" +
      "⚠️ *Common mistakes:*\n" +
      "• Status must be *settle* or *no settle*\n" +
      "• SO number must be correct\n" +
      "• Date format: d/m/yyyy or d/m"
    );
    return true;
  }
  // Validate required fields
  if (!parsed.soNumber || !parsed.driver || !parsed.statusRaw) {
    await sendMessage(chatId,
      "⚠️ *Missing required fields.*\n\n" +
      (!parsed.soNumber ? "❌ SO number not found\n" : "") +
      (!parsed.driver ? "❌ Driver name not found\n" : "") +
      (!parsed.statusRaw ? "❌ Status (settle/no settle) not found\n" : "") +
      "\nPlease check and resend."
    );
    return true;
  }

  const { driver, helper, soNumber, date, note, isSettle } = parsed;
  const now = new Date().toLocaleString("en-MY", {
    timeZone: "Asia/Kuala_Lumpur", day: "2-digit", month: "2-digit",
    year: "numeric", hour: "2-digit", minute: "2-digit"
  });
  const driverNote = `Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""} (${now})`;

  // Find the order
  const { data: order, error: findErr } = await supabase
    .from("orders")
    .select("id, so_number, customer_name, remark, status, is_multi_trip, planned_trips, first_delivery_date")
    .eq("so_number", soNumber).eq("type", "Delivery").maybeSingle();

  if (findErr) { await sendMessage(chatId, `❌ Database error: ${findErr.message}`); return true; }
  if (!order) { await sendMessage(chatId, `❌ SO *${soNumber}* not found.\nPlease check the SO number.`); return true; }

  const updatedRemark = order.remark ? `${order.remark} | ${driverNote}` : driverNote;

  // Record first delivery date if not set
  const firstDeliveryDate = order.first_delivery_date || date || null;

  // ── MULTI-TRIP ORDER ──────────────────────────────────────────
  if (order.is_multi_trip) {
    // Find the current Out for Delivery / Assigned trip
    const { data: trips } = await supabase
      .from("order_trips").select("*").eq("so_number", soNumber)
      .in("status", ["Out for Delivery", "Assigned", "Scheduled"])
      .order("trip_no");

    const currentTrip = trips?.find(t => t.status === "Out for Delivery" || t.status === "Assigned") || trips?.[0];

    if (!currentTrip) {
      await sendMessage(chatId, `⚠️ No active trip found for SO *${soNumber}*.`);
      return true;
    }

    // Mark current trip as Completed
    await supabase.from("order_trips")
      .update({ status: "Completed", driver, helper: helper || null, note: note || null })
      .eq("id", currentTrip.id);

    // Update order remark + first delivery date
    await supabase.from("orders")
      .update({ remark: updatedRemark, first_delivery_date: firstDeliveryDate, status: "In Progress" })
      .eq("so_number", soNumber);

    if (isSettle) {
      // Settled — mark order Delivered, cancel remaining trips
      await supabase.from("orders").update({ status: "Delivered" }).eq("so_number", soNumber);
      await supabase.from("order_trips")
        .update({ status: "Cancelled" })
        .eq("so_number", soNumber)
        .in("status", ["Scheduled", "Assigned"])
        .gt("trip_no", currentTrip.trip_no);

      await sendMessage(chatId,
        `✅ *SO ${soNumber} — Fully Settled (Trip ${currentTrip.trip_no}/${currentTrip.total_trips})*\n\n` +
        `👤 Customer: ${order.customer_name || "-"}\n` +
        `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
        `📅 Date: ${date || "-"}\n\n` +
        `_Remaining trips cancelled. Order marked Delivered._`
      );
      if (ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID,
        `✅ *Multi-Trip Settled*\n📋 SO: ${soNumber} | 👤 ${order.customer_name || "-"}\n` +
        `🔄 Trip ${currentTrip.trip_no}/${currentTrip.total_trips} — fully settled.`
      );

    } else {
      // Not settled — check if this was the last trip
      const remainingTrips = trips?.filter(t => t.trip_no > currentTrip.trip_no && t.status !== "Cancelled") || [];

      if (remainingTrips.length === 0) {
        // Last trip, not settled — auto-create next trip
        const newTripNo = currentTrip.total_trips + 1;
        const newTotal = newTripNo;
        const svNumber = currentTrip.sv_number || await getNextSvNumber();

        await supabase.from("order_trips").insert({
          so_number: soNumber, sv_number: svNumber,
          trip_no: newTripNo, total_trips: newTotal, status: "Scheduled",
        });
        // Update total_trips on all existing trips
        await supabase.from("order_trips").update({ total_trips: newTotal }).eq("so_number", soNumber);

        await sendMessage(chatId,
          `⚠️ *SO ${soNumber} — Trip ${currentTrip.trip_no} Not Settled*\n\n` +
          `👤 Customer: ${order.customer_name || "-"}\n` +
          `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
          (note ? `📝 Note: ${note}\n` : "") +
          `\n🔄 *Trip ${newTripNo} auto-created.* Admin to schedule next visit.`
        );
        if (ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID,
          `⚠️ *Multi-Trip Not Settled — Auto Extended*\n\n` +
          `📋 SO: *${soNumber}* | 👤 ${order.customer_name || "-"}\n` +
          `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
          (note ? `📝 Issue: ${note}\n` : "") +
          `\n🔄 Trip ${currentTrip.trip_no} was last trip — Trip ${newTripNo} auto-created.\n` +
          `Please schedule in delivery sheet.\n🔗 https://vhaus-delivery.vercel.app`
        );
      } else {
        // Still have remaining trips — just confirm
        const nextTrip = remainingTrips[0];
        await sendMessage(chatId,
          `⚠️ *SO ${soNumber} — Trip ${currentTrip.trip_no}/${currentTrip.total_trips} Not Settled*\n\n` +
          `👤 Customer: ${order.customer_name || "-"}\n` +
          `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
          (note ? `📝 Note: ${note}\n` : "") +
          `\n📅 Next: Trip ${nextTrip.trip_no} — ${nextTrip.scheduled_date ? nextTrip.scheduled_date : "date TBD"}`
        );
        if (ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID,
          `⚠️ *Multi-Trip Not Settled*\n\n` +
          `📋 SO: *${soNumber}* | 👤 ${order.customer_name || "-"}\n` +
          `🚛 Trip ${currentTrip.trip_no}/${currentTrip.total_trips} done. Next: Trip ${nextTrip.trip_no}.`
        );
      }
    }
    return true;
  }

  // ── SINGLE TRIP ORDER ─────────────────────────────────────────
  if (isSettle) {
    await supabase.from("orders")
      .update({ status: "Delivered", remark: updatedRemark, first_delivery_date: firstDeliveryDate })
      .eq("so_number", soNumber);

    await sendMessage(chatId,
      `✅ *SO ${soNumber} — Settled*\n\n` +
      `👤 Customer: ${order.customer_name || "-"}\n` +
      `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
      `📅 Date: ${date || "-"}\n\n` +
      `_Order marked as Delivered._`
    );
    if (ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID,
      `✅ *Delivery Settled*\n📋 SO: ${soNumber} | 👤 ${order.customer_name || "-"}\n` +
      `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n📅 ${date || "-"}`
    );

  } else {
    // Single trip not settled — create service pending
    const fullRemark = note ? `${updatedRemark} | Issue: ${note}` : updatedRemark;
    await supabase.from("orders")
      .update({ remark: fullRemark, first_delivery_date: firstDeliveryDate })
      .eq("so_number", soNumber);

    await supabase.from("service_pending").insert({
      so_number: soNumber, driver, helper: helper || null,
      date: date || null, note: note || null, status: "Pending"
    });

    await sendMessage(chatId,
      `⚠️ *SO ${soNumber} — Not Settled*\n\n` +
      `👤 Customer: ${order.customer_name || "-"}\n` +
      `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
      `📅 Date: ${date || "-"}\n` +
      (note ? `📝 Note: ${note}\n` : "") +
      `\n_Service Pending created. Admin has been notified._`
    );
    if (ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID,
      `🔧 *Service Pending — Action Required*\n\n` +
      `📋 SO: *${soNumber}* | 👤 ${order.customer_name || "-"}\n` +
      `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
      (note ? `📝 Issue: ${note}\n` : "") +
      `\n🔗 https://vhaus-delivery.vercel.app`
    );
  }

  return true;
};

// ── Order Trips API ──────────────────────────────────────────────

// GET /order-trips?date=2026-06-15  — trips scheduled for a date (for delivery schedule UI)
app.get("/order-trips", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });
  const { data, error } = await supabase
    .from("order_trips")
    .select("*, orders!order_trips_so_number_fkey(id, so_number, customer_name, address, contact, items, time_slot, balance, salesman, remark)")
    .eq("scheduled_date", date)
    .in("status", ["Scheduled", "Assigned"])
    .order("trip_no");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /order-trips/so/:soNumber — all trips for a specific SO
app.get("/order-trips/so/:soNumber", async (req, res) => {
  const { soNumber } = req.params;
  const { data, error } = await supabase
    .from("order_trips")
    .select("*")
    .eq("so_number", soNumber)
    .order("trip_no");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /order-trips/so/:soNumber/cancel-remaining already exists above
// Additional: PATCH /order-trips/:id/cancel — cancel a single trip
app.patch("/order-trips/:id/cancel", async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from("order_trips").update({ status: "Cancelled" }).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /order-trips/:id — update trip (date, status, driver, helper)
app.patch("/order-trips/:id", async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from("order_trips")
    .update(req.body)
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /order-trips/so/:soNumber/cancel-remaining — cancel all scheduled trips after a given trip_no
app.post("/order-trips/so/:soNumber/cancel-remaining", async (req, res) => {
  const { soNumber } = req.params;
  const { after_trip_no } = req.body;
  const { error } = await supabase
    .from("order_trips")
    .update({ status: "Cancelled" })
    .eq("so_number", soNumber)
    .in("status", ["Scheduled", "Assigned"])
    .gt("trip_no", after_trip_no || 0);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

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
  const { date, company_id } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });
  let routesQuery = supabase.from("delivery_routes").select("*").eq("delivery_date", date);
  if (company_id) routesQuery = routesQuery.eq("company_id", company_id);
  const { data: routes, error: routeErr } = await routesQuery.order("created_at");
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
  const isHardLocked = current?.status === "Out for Delivery" || current?.status === "Delivered";
  const isConfirmed = current?.status === "Confirmed";

  // Hard locked — only allow status transitions
  if (isHardLocked) {
    const keys = Object.keys(req.body);
    const onlyStatus = keys.length === 1 && keys[0] === "status";
    const validTransition = req.body.status === "Delivered" || req.body.status === "Out for Delivery";
    if (!onlyStatus || !validTransition) {
      return res.status(403).json({ error: "Route is locked. Only status update is allowed." });
    }
  }

  // Confirmed — allow unlock back to Pending, or upgrade to Out for Delivery
  // Block any other field edits
  if (isConfirmed && req.body.status !== "Pending" && req.body.status !== "Out for Delivery" && req.body.status !== "Delivered") {
    const keys = Object.keys(req.body);
    if (keys.some(k => k !== "status")) {
      return res.status(403).json({ error: "Route is Confirmed. Unlock to Pending first before editing." });
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

      // Update regular orders — skip multi-trip orders (they are managed by driver template)
      const { data: regularOrders } = await supabase
        .from("orders").select("id, is_multi_trip").in("id", orderIds);
      const regularOrderIds = (regularOrders || []).filter(o => !o.is_multi_trip).map(o => o.id);
      if (regularOrderIds.length > 0) {
        await supabase.from("orders").update({ status: orderStatus }).in("id", regularOrderIds);
      }

      // For multi-trip orders — update the trip status instead
      const multiOrderIds = (regularOrders || []).filter(o => o.is_multi_trip).map(o => o.id);
      if (multiOrderIds.length > 0 && req.body.status === "Out for Delivery") {
        // Get SO numbers for multi-trip orders in this route
        const { data: multiOrders } = await supabase
          .from("orders").select("so_number").in("id", multiOrderIds);
        const soNumbers = (multiOrders || []).map(o => o.so_number);
        // Mark their current Assigned/Scheduled trip as Out for Delivery
        for (const soNumber of soNumbers) {
          const { data: trips } = await supabase
            .from("order_trips").select("id").eq("so_number", soNumber)
            .in("status", ["Assigned", "Scheduled"]).order("trip_no").limit(1);
          if (trips && trips.length > 0) {
            await supabase.from("order_trips").update({ status: "Out for Delivery" }).eq("id", trips[0].id);
          }
        }
        // Also mark multi-trip orders as In Progress
        await supabase.from("orders").update({ status: "In Progress" }).in("id", multiOrderIds);
      }
    }
  }

  res.json(data);
});

// DELETE /delivery/routes/:id
app.delete("/delivery/routes/:id", async (req, res) => {
  const { id } = req.params;
  const { data: current } = await supabase.from("delivery_routes").select("status").eq("id", id).single();
  if (current?.status === "Out for Delivery" || current?.status === "Delivered" || current?.status === "Confirmed") {
    return res.status(403).json({ error: "Route is Confirmed or locked and cannot be deleted. Unlock first." });
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
  if (route?.status === "Out for Delivery" || route?.status === "Delivered" || route?.status === "Confirmed") {
    return res.status(403).json({ error: "Route is Confirmed or locked. Unlock to Pending first." });
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
  if (route?.status === "Out for Delivery" || route?.status === "Delivered" || route?.status === "Confirmed") {
    return res.status(403).json({ error: "Route is Confirmed or locked. Unlock to Pending first." });
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
  if (route?.status === "Out for Delivery" || route?.status === "Delivered" || route?.status === "Confirmed") {
    return res.status(403).json({ error: "Route is Confirmed or locked. Unlock to Pending first." });
  }

  const { error } = await supabase
    .from("delivery_route_orders").delete().eq("route_id", routeId).eq("order_id", orderId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});


// ── DO OCR — Extract Delivery Order ──────────────────────────────
const extractDOFromImage = async (base64Image) => {
  const prompt = `You are a supplier Delivery Order (DO) OCR assistant for V Haus Living (PG) Sdn Bhd, a furniture and home furnishing company in Malaysia.

Your job is to extract supplier DO information and match it back to the correct V Haus Sales Order (SO).

Return ONLY valid JSON.
Do not return markdown.
Do not explain anything.
Do not include comments.

Use this exact structure:

{
"doNumber": "",
"supplier": "",
"doDate": "YYYY-MM-DD",
"supplierReference": "",
"items": [
{
"itemCode": "",
"itemName": "",
"quantity": "",
"soNumber": "",
"supplierReference": "",
"isShowroom": false
}
]
}

==================================================
GENERAL EXTRACTION RULES
========================

supplier

* Supplier company name at the top of the document.
* NEVER return V Haus Living as supplier.
* Examples:

  * SIGNATURE BEDDING SDN BHD
  * GOODNITE
  * KING KOIL
  * SONNO
  * XYZ FURNITURE SDN BHD

doNumber

* Extract Delivery Order number.
* Common labels:

  * DO No
  * D/O No
  * Delivery Order No
  * Package No
  * Delivery Note No
  * Ref No
* Preserve full value if available.
* Example:

  * DO-46594
  * DO46594
  * D/O-10233

doDate

* Extract delivery order date.
* Common labels:

  * Date
  * Delivery Date
  * Package Date
  * Issue Date
* Convert to YYYY-MM-DD.
* If date is unreadable, return empty string.

supplierReference

* Supplier's own internal reference.
* Examples:

  * SO-42557
  * INV-88321
  * REF-10288
  * ORDER-9921
* Store here.
* NEVER use this field as V Haus SO number unless no better reference exists.

==================================================
ITEM EXTRACTION RULES
=====================

Extract ALL actual delivered products.

Each item must contain:

{
"itemCode": "",
"itemName": "",
"quantity": "",
"soNumber": "",
"supplierReference": "",
"isShowroom": false
}

itemCode

* Product code if visible.
* Examples:

  * MT8801
  * PMG MT8801-130
  * KJ4336
  * FT-V9-80
* Empty string if unavailable.

itemName

* Full product description.
* Combine sub-lines belonging to same item.
* Examples:

  * 6' TSUKI KAZE (HARMONY SPEC)
  * KING SIZE BED FRAME
  * 80CM ALUMINIUM MIRROR CABINET

quantity

* Keep quantity together with unit.
* Examples:

  * 1 UNIT
  * 2 PCS
  * 6.00 UNIT
  * 1 SET

==================================================
MOST IMPORTANT:
HOW TO DETERMINE V HAUS SO NUMBER
=================================

The goal is to find the V Haus Sales Order number.

Many suppliers print BOTH:

1. Supplier internal SO number
2. V Haus PO number

Example:

SO-42557
PO:30771

In this case:

CORRECT:
soNumber = 30771

WRONG:
soNumber = 42557

==================================================
SO NUMBER PRIORITY
==================

Priority 1 (Highest)

Use any of these:

PO:
P/O:
PO No:
PO Number:
Customer PO:
Customer Ref:
Customer Order:
Order By Customer:

Examples:

PO:30771
PO 30771
P/O 30771
Customer PO 30771

Return:

soNumber = "30771"

==================================================
Priority 2
==========

Handwritten SO number.

Examples:

30771
SO30771
SO:30771

Use if clearly linked to customer order.

==================================================
Priority 3
==========

SO number printed beside specific item.

Examples:

SO:11576
SO-11576

Only use if no PO exists.

==================================================
Priority 4
==========

If ONLY supplier SO exists and absolutely no PO/customer reference exists:

Use supplier SO.

Example:

SO-11576

Return:

soNumber = "11576"

==================================================
SUPPLIER INTERNAL SO RULE
=========================

Supplier internal SO often appears as:

SO-42557
SO-88312
ORDER-9911

If a PO number also exists:

PO:30771
SO-42557

Then:

soNumber = "30771"

supplierReference = "SO-42557"

NEVER use supplier SO when PO exists.

==================================================
SHOWROOM / DISPLAY STOCK RULE
=============================

If any of the following appears:

PO:YC
PO YC
SHOWROOM
DISPLAY
DISPLAY UNIT
SAMPLE
DEMO UNIT

Then:

soNumber = ""
isShowroom = true

==================================================
MULTIPLE ITEMS
==============

If each item has its own SO/PO reference:

Item A -> PO 30771
Item B -> PO 30772

Assign accordingly.

If one PO applies to whole document:

Apply same soNumber to all items.

==================================================
IGNORE THESE
============

Do not create items for:

* Carton
* Packing material
* Plastic wrap
* Documentation
* Spare screws
* Empty packaging

unless clearly billed as product.

==================================================
OCR CONFIDENCE RULE
===================

Never invent numbers.

If unsure:

soNumber = ""

Do not guess.

==================================================
FINAL OUTPUT RULE
=================

Return ONLY valid JSON.

No markdown.
No explanation.
No notes.
No comments.
No extra text.`;

  const response = await withTimeout(
    openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}`, detail: "high" } }
        ]
      }]
    }),
    60000,
    "DO extraction timeout"
  );

  const raw = response.choices?.[0]?.message?.content?.trim() || "";
  if (!raw) throw new Error("AI returned empty response");
  const clean = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(clean); }
  catch (err) { throw new Error("AI returned invalid JSON for DO"); }
};

// ── Handle DO Group Photo ─────────────────────────────────────────
const handleDOPhoto = async (chatId, base64Image) => {
  await sendMessage(chatId, "📦 Processing delivery order...");

  let doData;
  try {
    doData = await extractDOFromImage(base64Image);
  } catch (err) {
    await sendMessage(chatId, `❌ Could not read the DO.\n\nReason: ${err.message}\n\nPlease try again with a clearer photo.`);
    return;
  }

  if (!doData.items || doData.items.length === 0) {
    await sendMessage(chatId, "❌ No items found in the DO. Please try again with a clearer photo.");
    return;
  }

  const arrivalDate = new Date().toLocaleString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).split(",")[0].trim();
  const results = { updated: [], notFound: [], showroom: [], duplicate: [] };

  for (const item of doData.items) {
    // Showroom items — log to do_review
    if (item.isShowroom || !item.soNumber) {
      await supabase.from("do_review").insert({
        do_number: doData.doNumber || null,
        supplier: doData.supplier || null,
        do_date: doData.doDate || arrivalDate,
        so_number: item.soNumber || null,
        item_code: item.itemCode || null,
        item_name: item.itemName || null,
        quantity: item.quantity || null,
        reason: item.isShowroom ? "showroom" : "no_so",
        status: "Pending",
      });
      if (item.isShowroom) results.showroom.push(item.itemName);
      else results.notFound.push({ itemName: item.itemName, soNumber: item.soNumber });
      continue;
    }

    // Find matching orders by SO number
    const { data: orders } = await supabase
      .from("orders")
      .select("id, so_number, items, status")
      .eq("so_number", item.soNumber)
      .in("status", ["Pending", "In Progress"]);

    if (!orders || orders.length === 0) {
      await supabase.from("do_review").insert({
        do_number: doData.doNumber || null,
        supplier: doData.supplier || null,
        do_date: doData.doDate || arrivalDate,
        so_number: item.soNumber,
        item_code: item.itemCode || null,
        item_name: item.itemName || null,
        quantity: item.quantity || null,
        reason: "so_not_found",
        status: "Pending",
      });
      results.notFound.push({ itemName: item.itemName, soNumber: item.soNumber });
      continue;
    }

    let updatedAny = false;
    let alreadyHasDate = false;

    for (const order of orders) {
      const items = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
      let matched = false;

      const updatedItems = items.map(oi => {
        // Match by item code first, then by name (case-insensitive partial match)
        const codeMatch = item.itemCode && oi.itemCode &&
          oi.itemCode.toLowerCase().trim() === item.itemCode.toLowerCase().trim();
        const nameMatch = item.itemName && oi.itemName &&
          (oi.itemName.toLowerCase().includes(item.itemName.toLowerCase().substring(0, 8)) ||
           item.itemName.toLowerCase().includes(oi.itemName.toLowerCase().substring(0, 8)));

        if (codeMatch || nameMatch) {
          matched = true;
          if (oi.arrivalDate) {
            alreadyHasDate = true;
            return oi; // keep existing date, flag as duplicate
          }
          return { ...oi, arrivalDate };
        }
        return oi;
      });

      if (matched) {
        if (alreadyHasDate) {
          // Duplicate — flag for review
          await supabase.from("do_review").insert({
            do_number: doData.doNumber || null,
            supplier: doData.supplier || null,
            do_date: doData.doDate || arrivalDate,
            so_number: item.soNumber,
            item_code: item.itemCode || null,
            item_name: item.itemName || null,
            quantity: item.quantity || null,
            reason: "duplicate_arrival",
            status: "Pending",
          });
          results.duplicate.push({ itemName: item.itemName, soNumber: item.soNumber });
        } else {
          await supabase.from("orders").update({ items: JSON.stringify(updatedItems) }).eq("id", order.id);
          results.updated.push({ itemName: item.itemName, soNumber: item.soNumber });
          updatedAny = true;
        }
      }
    }

    if (!updatedAny && !alreadyHasDate) {
      // Item not matched in any order items
      await supabase.from("do_review").insert({
        do_number: doData.doNumber || null,
        supplier: doData.supplier || null,
        do_date: doData.doDate || arrivalDate,
        so_number: item.soNumber,
        item_code: item.itemCode || null,
        item_name: item.itemName || null,
        quantity: item.quantity || null,
        reason: "item_not_matched",
        status: "Pending",
      });
      results.notFound.push({ itemName: item.itemName, soNumber: item.soNumber });
    }
  }

  // Build reply
  const lines = [
    `📦 *DO Processed — ${doData.supplier || "Unknown Supplier"}*`,
    `DO#: ${doData.doNumber || "-"} | Date: ${doData.doDate || arrivalDate}`,
    `Arrival date set to: *${arrivalDate}*`,
    ``,
  ];

  if (results.updated.length > 0) {
    lines.push(`✅ *${results.updated.length} item(s) updated:*`);
    results.updated.forEach(r => lines.push(`  • ${r.itemName} (SO ${r.soNumber})`));
    lines.push(``);
  }

  if (results.duplicate.length > 0) {
    lines.push(`⚠️ *${results.duplicate.length} item(s) already have arrival date — sent to review:*`);
    results.duplicate.forEach(r => lines.push(`  • ${r.itemName} (SO ${r.soNumber})`));
    lines.push(``);
  }

  if (results.showroom.length > 0) {
    lines.push(`🏷️ *${results.showroom.length} showroom item(s) logged:*`);
    results.showroom.forEach(name => lines.push(`  • ${name}`));
    lines.push(``);
  }

  if (results.notFound.length > 0) {
    lines.push(`❌ *${results.notFound.length} item(s) unmatched — check web app DO Review:*`);
    results.notFound.forEach(r => lines.push(`  • ${r.itemName}${r.soNumber ? ` (SO ${r.soNumber})` : ""}`));
  }

  if (results.notFound.length > 0 || results.duplicate.length > 0) {
    lines.push(``);
    lines.push(`_Check DO Review tab in web app to resolve unmatched items._`);
    if (ADMIN_CHAT_ID) {
      await sendMessage(ADMIN_CHAT_ID,
        `📦 *DO Review Required*\n\n` +
        `Supplier: ${doData.supplier || "-"}\n` +
        `DO#: ${doData.doNumber || "-"}\n\n` +
        `${results.duplicate.length} duplicate(s), ${results.notFound.length} unmatched item(s).\n` +
        `🔗 https://vhaus-delivery.vercel.app`
      );
    }
  }

  await sendMessage(chatId, lines.join("\n"));
};

// ── Service Pending API ──────────────────────────────────────────

// GET /service-pending
app.get("/service-pending", async (req, res) => {
  const { company_id } = req.query;
  let query = supabase.from("service_pending").select("*").eq("status", "Pending").order("created_at", { ascending: false });
  if (company_id) query = query.eq("company_id", company_id);
  const { data, error } = await query;
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

  // Get original order — filter by type=Delivery to avoid duplicates
  const { data: order, error: orderErr } = await supabase
    .from("orders").select("*").eq("so_number", sp.so_number).eq("type", "Delivery").maybeSingle();
  if (orderErr || !order) return res.status(404).json({ error: `Original delivery order for SO ${sp.so_number} not found` });

  // Get next SV number
  const svNumber = await getNextSvNumber();

  // Build service note
  const serviceNote = `${sp.so_number}${sp.note ? ` — ${sp.note}` : ""}`;

  // Build remark combining existing remark + driver info + admin remark
  const remarkParts = [
    order.remark || null,
    `Converted from Service Pending`,
    `Driver: ${sp.driver}${sp.helper ? ` | Helper: ${sp.helper}` : ""}`,
    sp.note ? `Issue: ${sp.note}` : null,
    adminRemark ? `Admin note: ${adminRemark}` : null,
  ].filter(Boolean);

  // UPDATE the existing order — change type to Service, set sv_number
  const { data: updatedOrder, error: updateErr } = await supabase
    .from("orders")
    .update({
      type: "Service",
      sv_number: svNumber,
      service_note: serviceNote,
      remark: remarkParts.join(" | "),
      status: "Pending",
    })
    .eq("id", order.id)
    .select().single();
  if (updateErr) return res.status(500).json({ error: updateErr.message });

  // Mark service_pending as Converted
  await supabase.from("service_pending").update({ status: "Converted" }).eq("id", id);

  res.json({ success: true, svNumber, order: updatedOrder });
});

// DELETE /service-pending/:id — remove (not applicable)
app.delete("/service-pending/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("service_pending").update({ status: "Removed" }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Admin User Management API ────────────────────────────────────
// Uses Supabase service role key to create/update auth users

// POST /admin/users — create new user
app.post("/admin/users", async (req, res) => {
  const { name, email, password, role, company_id, telegram_id, salesman_name } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ error: "Missing required fields." });

  // Create auth user
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (authErr) return res.status(400).json({ success: false, error: authErr.message });

  // Create user profile
  const { error: profileErr } = await supabase.from("users").insert({
    id: authData.user.id,
    name, email, role,
    company_id: company_id || null,
    telegram_id: telegram_id || null,
    salesman_name: salesman_name || null,
    is_active: true,
  });
  if (profileErr) return res.status(500).json({ success: false, error: profileErr.message });
  res.json({ success: true, userId: authData.user.id });
});

// PATCH /admin/users/:id/password — update user password
app.patch("/admin/users/:id/password", async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required." });
  const { error } = await supabase.auth.admin.updateUserById(id, { password });
  if (error) return res.status(400).json({ success: false, error: error.message });
  res.json({ success: true });
});

// ── DO Review API ────────────────────────────────────────────────

// GET /do-review — list all pending DO review items
app.get("/do-review", async (req, res) => {
  const { data, error } = await supabase
    .from("do_review")
    .select("*")
    .eq("status", "Pending")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PATCH /do-review/:id/resolve — mark as resolved (admin linked manually)
app.patch("/do-review/:id/resolve", async (req, res) => {
  const { id } = req.params;
  const { so_number, item_code, arrival_date } = req.body;

  // If admin provides SO + item to link, update the order item
  if (so_number && item_code) {
    const date = arrival_date || new Date().toLocaleString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).split(",")[0].trim();
    const { data: orders } = await supabase.from("orders").select("id, items").eq("so_number", so_number).in("status", ["Pending", "In Progress"]);
    for (const order of (orders || [])) {
      const items = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
      const updated = items.map(oi => {
        if (oi.itemCode === item_code || (oi.itemName && oi.itemName.toLowerCase().includes(item_code.toLowerCase()))) {
          return { ...oi, arrivalDate: date };
        }
        return oi;
      });
      await supabase.from("orders").update({ items: JSON.stringify(updated) }).eq("id", order.id);
    }
  }

  const { error } = await supabase.from("do_review").update({ status: "Resolved" }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// PATCH /do-review/:id/dismiss — dismiss (not applicable)
app.patch("/do-review/:id/dismiss", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("do_review").update({ status: "Dismissed" }).eq("id", id);
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

    // ── Group C: DO (Supplier Delivery Order) photos ──────────────
    if (String(chatId) === String(DO_GROUP_CHAT_ID)) {
      if (message.photo && message.photo.length > 0) {
        const photo = message.photo[message.photo.length - 1];
        const fileUrl = await getFileUrl(photo.file_id);
        const base64Image = await downloadImageAsBase64(fileUrl);
        await handleDOPhoto(chatId, base64Image);
      } else if (message.text) {
        await sendMessage(chatId, "📷 Please send a photo of the supplier delivery order to process it.");
      }
      return;
    }

    // ── Auth check for Group A (salesman bot) ─────────────────────
    // Allow /start and /help without auth so unregistered users get a useful message
    const isPublicCommand = message.text && ["/start", "/help", "4", "help"].includes(message.text.trim().toLowerCase());
    if (!isPublicCommand) {
      const telegramUser = await getTelegramUser(userId);
      if (!telegramUser) {
        await sendMessage(chatId,
          `❌ *Not Registered*\n\nYour Telegram account is not linked to this system.\n\nPlease contact your manager to set up your account.`
        );
        return;
      }
      // Attach company_id to the draft key context
      message._companyId = telegramUser.company_id;
      message._telegramUser = telegramUser;
    }

    // ── Text messages ─────────────────────────────────────────────
    if (message.text) {
      const text = message.text.trim();
      const lower = text.toLowerCase();
      const session = getSession(draftKey);

      // /schedule (admin command — always works)
      if (text.startsWith("/schedule")) {
        await handleScheduleCommand(chatId, text);
        return;
      }

      // /approve and /reject — OM only
      if (text.startsWith("/approve") || text.startsWith("/reject")) {
        await handleApprovalCommand(chatId, userId, text);
        return;
      }

      // Active session — route to session handler
      if (session) {
        const handled = await handleSession(chatId, userId, text, message.from);
        if (handled) return;
      }

      // Menu selection or keyword
      if (["1", "new order", "new"].includes(lower)) {
        clearSession(draftKey);
        setSession(draftKey, "new_order", "waiting_photo", {});
        await sendMessage(chatId, "📷 *New Order*\n\nSend me the sales order photo.\n\n_Type *cancel* to go back to the menu._");
        return;
      }
      if (["2", "reschedule"].includes(lower)) {
        clearSession(draftKey);
        setSession(draftKey, "reschedule", "waiting_so", {});
        await sendMessage(chatId, "📅 *Reschedule*\n\nWhich SO do you want to reschedule?\n\nFor multi-trip orders include the trip number:\n_e.g. 11576 Trip 2_\n\nFor single orders just type the SO number:\n_e.g. 11576_\n\nType *cancel* to go back.");
        return;
      }
      if (["3", "flag", "flag order", "flag wrong order"].includes(lower)) {
        clearSession(draftKey);
        setSession(draftKey, "flag", "waiting_so", {});
        await sendMessage(chatId, "🚨 *Flag Wrong Order*\n\nWhich SO number has wrong info?\n\n_Type *cancel* to go back._");
        return;
      }
      if (["4", "help", "/help", "/start", "menu", "hi", "hello"].includes(lower)) {
        clearSession(draftKey);
        await showMenu(chatId);
        return;
      }

      // Unrecognised — show menu
      clearSession(draftKey);
      await showMenu(chatId, "Sorry, I didn\'t understand that. Here\'s what I can do:");
      return;
    }

    // ── Photo messages ────────────────────────────────────────────
    if (!message.photo || message.photo.length === 0) return;

    const photoSession = getSession(draftKey);
    if (!photoSession || photoSession.mode !== "new_order" || photoSession.step !== "waiting_photo") {
      await showMenu(chatId, "Please select *1\u{31}\u{FE0F}\u{20E3} New Order* first before sending a photo.");
      return;
    }

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
      await sendMessage(chatId, `❌ AI extraction failed.\n\nReason: ${err.message}\n\nPlease resend a clearer photo or try again later.`);
      return;
    }

    if (!data.soNumber) {
      await sendMessage(chatId, "❌ Could not find SO Number in the image. Please try again with a clearer image.");
      return;
    }

    const normalized = normalizeDeliveryDate(data.deliveryDate, data.orderDate);
    data.deliveryDate = normalized.deliveryDate;
    data.originalDeliveryText = normalized.originalDeliveryText;
    if (normalized.remarkNote) {
      data.remark = data.remark ? `${data.remark} | ${normalized.remarkNote}` : normalized.remarkNote;
    }

    if (hasWardrobeItem(data.items)) {
      const wardrobeItems = data.items.filter(i => WARDROBE_KEYWORDS.some(kw => (i.itemName||"").toLowerCase().includes(kw.toLowerCase()))).map(i => i.itemName).join(", ");
      setSession(draftKey, "new_order", "waiting_trips", { draft: data });
      await sendMessage(chatId,
        `📋 *Wardrobe / Fitting item detected:*\n_${wardrobeItems}_\n\n` +
        `🔄 How many trips are needed for this order?\n\n_Reply with a number (e.g. 3)_\n_Type 1 if only 1 trip needed._`
      );
      return;
    }

    setSession(draftKey, "new_order", "confirm", { draft: data });
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