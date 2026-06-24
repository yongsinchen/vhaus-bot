require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
const multer = require("multer");

const app = express();

// ── CORS — must be before all routes ─────────────────────────────
app.use(cors({
  origin: ["https://vhaus-delivery.vercel.app", "https://pulseos.vercel.app", "https://pulseos-my.vercel.app", "http://localhost:3000"],
  allowedHeaders: ["Content-Type", "Authorization"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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

// ── Auth middleware (used by all protected routes) ───────────────
const requireRole = (allowedRoles) => async (req, res, next) => {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const { data: { user: authUser }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authUser) return res.status(401).json({ error: "Invalid token" });
    const { data: profile } = await supabase
      .from("users")
      .select("id, role, company_id, branch_id, is_active")
      .eq("id", authUser.id)
      .single();
    if (!profile || !profile.is_active) return res.status(403).json({ error: "Account inactive" });
    if (!allowedRoles.includes(profile.role)) return res.status(403).json({ error: "Insufficient permissions" });
    req.user = profile;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
const MANAGE_ROLES = ["master", "manager", "company_admin"];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

// ── Supabase Storage — Upload image ──────────────────────────────
const uploadImageToStorage = async (base64Image, bucket, filename) => {
  try {
    const buffer = Buffer.from(base64Image, "base64");
    const { error } = await supabase.storage
      .from(bucket)
      .upload(filename, buffer, { contentType: "image/jpeg", upsert: true });
    if (error) { console.error("Storage upload error:", error.message); return null; }
    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(filename);
    return urlData?.publicUrl || null;
  } catch (e) { console.error("uploadImageToStorage error:", e.message); return null; }
};

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

  // ✅ Duplicate SO check — company-scoped to match UNIQUE(company_id, so_number)
  // SO numbers are pre-printed per company, so the same number can legitimately
  // exist across different companies — only a duplicate WITHIN a company is blocked.
  let dupQuery = supabase
    .from("orders").select("id").eq("so_number", draft.soNumber).is("deleted_at", null);
  if (draft.companyId) dupQuery = dupQuery.eq("company_id", draft.companyId);
  const { data: existing } = await dupQuery.maybeSingle();

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

  // Upload SO photo to Supabase Storage if available
  let photoUrl = null;
  if (draft.photoBase64) {
    const month = new Date().toISOString().slice(0, 7);
    const filename = `${month}/SO-${String(draft.soNumber || Date.now()).replace(/[^a-zA-Z0-9]/g, "-")}.jpg`;
    photoUrl = await uploadImageToStorage(draft.photoBase64, "sales-order-photos", filename);
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
    branch_id: draft.branchId || null,
    created_by_user_id: draft.createdByUserId || null,
    main_salesman_user_id: draft.mainSalesmanUserId || null,
    ...(photoUrl && { photo_url: photoUrl }),
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
    "🏠 *V Haus Living Bot*",
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
    `👋 Hello ${name}! Welcome to *V Haus Living (PG) Bot*`,
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

  // Upload DO photo to Supabase Storage
  let doPhotoUrl = null;
  const doMonth = new Date().toISOString().slice(0, 7);
  const safeSupplier = (doData.supplier || "unknown").replace(/[^a-zA-Z0-9]/g, "-").substring(0, 30);
  const doFilename = `${doMonth}/DO-${safeSupplier}-${Date.now()}.jpg`;
  doPhotoUrl = await uploadImageToStorage(base64Image, "supplier-do-photos", doFilename);

  // Create supplier_deliveries record
  const { data: supplierDelivery } = await supabase.from("supplier_deliveries").insert({
    do_number: doData.doNumber || null,
    supplier: doData.supplier || null,
    do_date: doData.doDate || arrivalDate,
    supplier_reference: doData.supplierReference || null,
    photo_url: doPhotoUrl,
    status: "Processed",
  }).select().single();
  const supplierDeliveryId = supplierDelivery?.id || null;

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
        supplier_delivery_id: supplierDeliveryId || null,
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
        supplier_delivery_id: supplierDeliveryId || null,
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
        supplier_delivery_id: supplierDeliveryId || null,
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
        supplier_delivery_id: supplierDeliveryId || null,
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
  const { data, error } = await supabase
    .from("service_pending")
    .select("*")
    .eq("status", "Pending")
    .order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /service-pending/:id/convert — Option B: new service order linked to original
app.post("/service-pending/:id/convert", async (req, res) => {
  const { id } = req.params;
  const { remark: adminRemark, delivery_date } = req.body || {};

  const { data: sp, error: spErr } = await supabase
    .from("service_pending").select("*").eq("id", id).single();
  if (spErr || !sp) return res.status(404).json({ error: "Service pending not found" });

  // Get original delivery order for customer info
  const { data: origOrder } = await supabase
    .from("orders").select("*").eq("so_number", sp.so_number).eq("type", "Delivery").maybeSingle();

  // Get next SV number
  const svNumber = await getNextSvNumber();

  const serviceNote = [
    `Linked to SO: ${sp.so_number}`,
    sp.note ? `Issue: ${sp.note}` : null,
    `Driver: ${sp.driver}${sp.helper ? ` | Helper: ${sp.helper}` : ""}`,
    adminRemark ? `Admin note: ${adminRemark}` : null,
  ].filter(Boolean).join(" | ");

  // CREATE NEW service order (original delivery stays intact)
  const { data: newOrder, error: insertErr } = await supabase
    .from("orders").insert({
      so_number: sp.so_number,
      sv_number: svNumber,
      customer_name: origOrder?.customer_name || null,
      address: origOrder?.address || null,
      contact: origOrder?.contact || null,
      salesman: origOrder?.salesman || null,
      order_amount: origOrder?.order_amount || null,
      balance: origOrder?.balance || null,
      delivery_date: delivery_date || null,
      type: "Service",
      service_note: serviceNote,
      remark: serviceNote,
      status: "Pending",
      items: origOrder?.items || JSON.stringify([]),
      linked_so: sp.so_number,
      company_id: origOrder?.company_id || null,
      photo_url: origOrder?.photo_url || null,
    }).select().single();
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


// ── AI Auto-Scheduler ─────────────────────────────────────────────

// GET /auto-schedule/orders?date=&company_id= — get unassigned orders with AI duration suggestions
app.get("/auto-schedule/orders", async (req, res) => {
  const { date, company_id } = req.query;
  if (!date) return res.status(400).json({ error: "date required" });

  // Get unassigned orders for the date
  let query = supabase.from("orders").select("*")
    .eq("delivery_date", date)
    .in("status", ["Pending", "In Progress"]);
  if (company_id) query = query.eq("company_id", company_id);
  const { data: orders, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Get assigned order IDs for this date
  const { data: assigned } = await supabase
    .from("delivery_route_orders")
    .select("order_id, delivery_routes!inner(delivery_date)")
    .eq("delivery_routes.delivery_date", date);
  const assignedIds = new Set((assigned || []).map(a => a.order_id));
  const unassigned = (orders || []).filter(o => !assignedIds.has(o.id));

  // For each order, get AI duration suggestion from history
  const ordersWithSuggestions = await Promise.all(unassigned.map(async (order) => {
    const items = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
    const itemKeywords = items.map(i => i.itemName).filter(Boolean).join(", ");

    // Detect item type
    const isWardrobe = itemKeywords.toLowerCase().match(/wardrobe|almari|fitting|installation/);
    const itemType = order.type === "Service" ? "Service" : isWardrobe ? "Wardrobe" : "Delivery";

    // Look up duration history for similar jobs
    let suggestedDuration = null;
    if (company_id) {
      const { data: history } = await supabase
        .from("duration_history")
        .select("duration_minutes")
        .eq("company_id", company_id)
        .eq("item_type", itemType)
        .order("created_at", { ascending: false })
        .limit(10);

      if (history && history.length > 0) {
        const avg = Math.round(history.reduce((s, h) => s + h.duration_minutes, 0) / history.length);
        suggestedDuration = avg;
      } else {
        // Default suggestions
        suggestedDuration = itemType === "Wardrobe" ? 210 : itemType === "Service" ? 120 : 90;
      }
    }

    return {
      ...order,
      items,
      itemType,
      itemKeywords,
      suggestedDuration,
      estimatedDuration: order.estimated_duration || suggestedDuration,
    };
  }));

  // Get available vehicles
  let vQuery = supabase.from("delivery_vehicles").select("*").eq("status", "Active");
  if (company_id) vQuery = vQuery.eq("company_id", company_id);
  const { data: vehicles } = await vQuery;

  // Get company settings (base location, work hours)
  const { data: settings } = company_id
    ? await supabase.from("company_settings").select("*").eq("company_id", company_id).single()
    : { data: null };

  res.json({
    orders: ordersWithSuggestions,
    vehicles: vehicles || [],
    settings: settings || { work_start: "09:00", work_end: "20:00", base_address: "Bukit Mertajam, Pulau Pinang" },
  });
});

// POST /auto-schedule/generate — AI generates the schedule
app.post("/auto-schedule/generate", async (req, res) => {
  const { date, company_id, orders, vehicles, settings } = req.body;
  if (!date || !orders || !vehicles) return res.status(400).json({ error: "Missing required fields" });

  if (orders.length === 0) return res.status(400).json({ error: "No orders to schedule" });
  if (vehicles.length === 0) return res.status(400).json({ error: "No vehicles available" });

  const baseAddress = settings?.base_address || "Bukit Mertajam, Pulau Pinang";
  const workStart = settings?.work_start || "09:00";
  const workEnd = settings?.work_end || "20:00";

  const prompt = `You are a delivery route scheduler for a furniture company in Penang/Kedah, Malaysia.

Schedule the following orders across the available vehicles for ${date}.

BASE LOCATION: ${baseAddress}
WORKING HOURS: ${workStart} to ${workEnd}
VEHICLES: ${vehicles.length} lorry/lorries available

ORDERS TO SCHEDULE:
${orders.map((o, i) => `
Order ${i+1}:
  SO: ${o.so_number}
  Customer: ${o.customer_name}
  Address: ${o.address}
  Type: ${o.itemType} (${o.type})
  Items: ${o.itemKeywords}
  Duration: ${o.estimatedDuration} minutes
  Time preference: ${o.time_slot || "No preference"}
  Balance: ${parseFloat(o.balance) > 0 ? "RM " + o.balance + " outstanding" : "Settled"}
`).join("")}

VEHICLES:
${vehicles.map((v, i) => "Vehicle " + (i+1) + ": " + (v.vehicle_plate || "No plate") + " - Driver: " + (v.driver_name || "TBD")).join("\n")}

SCHEDULING RULES:
1. Group orders by area to minimize travel time (Bukit Mertajam, Georgetown, Simpang Ampat, Seberang Jaya, Kepala Batas, Alor Setar etc are different areas)
2. Schedule Wardrobe/fitting jobs EARLY in the day (they take 3-4 hours)
3. Respect time preferences (morning=9AM-12PM, afternoon=12PM-3PM, evening=3PM-6PM, specific time = hard constraint)
4. Service jobs go LAST (most variable)
5. Factor in ~20-30 min travel between nearby areas, ~45-60 min between far areas
6. Last stop must finish early enough to return to base by ${workEnd}
7. If orders cannot all fit, flag overflow orders
8. Distribute evenly across vehicles if multiple vehicles

Return ONLY valid JSON, no markdown:
{
  "vehicles": [
    {
      "vehicle_id": "vehicle id or plate",
      "vehicle_plate": "plate number",
      "driver_name": "driver name",
      "stops": [
        {
          "so_number": "SO number",
          "customer_name": "name",
          "address": "address",
          "area": "detected area name",
          "start_time": "09:00",
          "end_time": "10:30",
          "duration_minutes": 90,
          "sequence": 1,
          "notes": "any notes e.g. wardrobe assembly, collect balance"
        }
      ],
      "return_time": "estimated return to base time",
      "total_minutes": 0,
      "warnings": []
    }
  ],
  "overflow": [
    {
      "so_number": "SO number",
      "reason": "why it cannot fit"
    }
  ],
  "summary": "brief summary of the proposed schedule"
}`;

  try {
    const response = await withTimeout(
      openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }]
      }),
      60000,
      "Auto-scheduler timeout"
    );

    const raw = response.choices?.[0]?.message?.content?.trim() || "";
    const clean = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
    const schedule = JSON.parse(clean);
    res.json({ success: true, schedule });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /auto-schedule/approve — create routes from approved schedule
app.post("/auto-schedule/approve", async (req, res) => {
  const { date, company_id, schedule, durations } = req.body;
  if (!date || !schedule) return res.status(400).json({ error: "Missing required fields" });

  const createdRoutes = [];

  for (const vehicle of schedule.vehicles) {
    if (!vehicle.stops || vehicle.stops.length === 0) continue;

    // Create route
    const { data: route, error: routeErr } = await supabase
      .from("delivery_routes")
      .insert({
        delivery_date: date,
        lorry_plate: vehicle.vehicle_plate || null,
        driver_name: vehicle.driver_name || null,
        company_id: company_id || null,
        status: "Confirmed",
        notes: `Auto-scheduled. Est. return: ${vehicle.return_time || "-"}`,
      })
      .select()
      .single();

    if (routeErr) { console.error("Route create error:", routeErr); continue; }

    // Add orders to route with sequence + time slots
    for (const stop of vehicle.stops) {
      const { data: order } = await supabase
        .from("orders")
        .select("id, estimated_duration")
        .eq("so_number", stop.so_number)
        .single();

      if (!order) continue;

      const timeRange = stop.start_time && stop.end_time
        ? `${stop.start_time} - ${stop.end_time}`
        : null;

      await supabase.from("delivery_route_orders").insert({
        route_id: route.id,
        order_id: order.id,
        sequence_no: stop.sequence,
        scheduled_time_range: timeRange,
        route_note: stop.notes || null,
      });

      // Update order time_slot
      if (timeRange) {
        await supabase.from("orders").update({ time_slot: timeRange }).eq("id", order.id);
      }
    }

    createdRoutes.push(route);
  }

  // Save duration history for learning
  if (durations && durations.length > 0 && company_id) {
    for (const d of durations) {
      await supabase.from("duration_history").insert({
        company_id,
        item_type: d.itemType,
        item_keywords: d.itemKeywords,
        area: d.area,
        duration_minutes: d.duration_minutes,
      });
    }
  }

  res.json({ success: true, routes: createdRoutes });
});

// ── Auth Profile API ─────────────────────────────────────────────
app.get("/auth/profile", async (req, res) => {
  const userId = req.query.uid;
  if (!userId) return res.status(400).json({ error: "Missing user ID" });
  const { data: user, error } = await supabase.from("users").select("*").eq("id", userId).single();
  if (error || !user) return res.status(404).json({ error: "User not found" });
  let company = null;
  if (user.company_id) {
    const { data: companyData } = await supabase.from("companies").select("id, name, code").eq("id", user.company_id).single();
    company = companyData || null;
  }
  res.json({ ...user, companies: company });
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

// PATCH /do-review/:id/add-to-stock — match to product master and add to inventory
app.patch("/do-review/:id/add-to-stock", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { product_id, warehouse_id, quantity } = req.body;
    if (!product_id || !warehouse_id) return res.status(400).json({ error: "product_id and warehouse_id required" });
    const { data: review } = await supabase.from("do_review").select("*").eq("id", req.params.id).single();
    if (!review) return res.status(404).json({ error: "Review item not found" });
    const qty = Number(quantity) || 1;
    await adjustStock(req.user.company_id, warehouse_id, product_id, qty, "in", "do", review.supplier_delivery_id, `DO #${review.do_number} — ${review.item_name}`, req.user.id);
    await supabase.from("do_review").update({ status: "Resolved" }).eq("id", req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Auth Profile API ─────────────────────────────────────────────
app.get("/auth/profile", async (req, res) => {
  const userId = req.query.uid;
  if (!userId) return res.status(400).json({ error: "Missing user ID" });
  const { data: user, error } = await supabase.from("users").select("*").eq("id", userId).single();
  if (error || !user) return res.status(404).json({ error: "User not found" });
  let company = null;
  if (user.company_id) {
    const { data: companyData } = await supabase.from("companies").select("id, name, code").eq("id", user.company_id).single();
    company = companyData || null;
  }
  res.json({ ...user, companies: company });
});

// ── Admin User Management API ─────────────────────────────────────

// GET /admin/users/list — list all users (service role bypasses RLS)
app.get("/admin/users/list", async (req, res) => {
  const { company_id } = req.query;
  let query = supabase.from("users").select("*, companies(name, code)").order("name");
  if (company_id) query = query.eq("company_id", company_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post("/admin/users", async (req, res) => {
  const { name, email, password, role, company_id, telegram_id, salesman_name } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ error: "Missing required fields." });
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (authErr) return res.status(400).json({ success: false, error: authErr.message });
  const { error: profileErr } = await supabase.from("users").insert({
    id: authData.user.id, name, email, role,
    company_id: company_id || null, telegram_id: telegram_id || null,
    salesman_name: salesman_name || null, is_active: true,
  });
  if (profileErr) return res.status(500).json({ success: false, error: profileErr.message });
  res.json({ success: true, userId: authData.user.id });
});

app.patch("/admin/users/:id/password", async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required." });
  const { error } = await supabase.auth.admin.updateUserById(id, { password });
  if (error) return res.status(400).json({ success: false, error: error.message });
  res.json({ success: true });
});

// ── Services API ──────────────────────────────────────────────────

// GET /services/unscheduled — service orders with no delivery_date
app.get("/services/unscheduled", async (req, res) => {
  const { company_id } = req.query;
  let query = supabase.from("orders").select("*")
    .eq("type", "Service")
    .is("delivery_date", null)
    .not("status", "in", '("Delivered","Serviced","Cancelled")')
    .order("created_at", { ascending: false });
  if (company_id) query = query.eq("company_id", company_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PATCH /orders/:id/set-date — set delivery date on an order
app.patch("/orders/:id/set-date", async (req, res) => {
  const { id } = req.params;
  const { delivery_date } = req.body;
  const { data, error } = await supabase.from("orders")
    .update({ delivery_date: delivery_date || null })
    .eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/services", async (req, res) => {
  const { company_id, salesman, status } = req.query;
  let query = supabase.from("orders").select("*").eq("type", "Service").order("created_at", { ascending: false });
  if (company_id) query = query.eq("company_id", company_id);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  let result = data || [];
  if (salesman) {
    const name = salesman.toLowerCase().trim();
    result = result.filter(o => (o.salesman || "").split("/").map(s => s.trim().toLowerCase()).includes(name));
  }
  res.json(result);
});

// ── Supplier Deliveries API ───────────────────────────────────────
app.get("/supplier-deliveries", async (req, res) => {
  const { company_id, supplier, from_date, to_date, limit = 100 } = req.query;
  let query = supabase.from("supplier_deliveries").select("*").order("created_at", { ascending: false }).limit(parseInt(limit));
  if (company_id) query = query.eq("company_id", company_id);
  if (supplier) query = query.ilike("supplier", `%${supplier}%`);
  if (from_date) query = query.gte("do_date", from_date);
  if (to_date) query = query.lte("do_date", to_date);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get("/supplier-deliveries/:id", async (req, res) => {
  try {
    const { data: delivery, error } = await supabase.from("supplier_deliveries").select("*").eq("id", req.params.id).single();
    if (error || !delivery) return res.status(404).json({ error: "Not found" });
    const { data: reviews } = await supabase.from("do_review").select("*").eq("supplier_delivery_id", delivery.id).order("created_at");
    res.json({ delivery, items: reviews || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/supplier-deliveries/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { do_number, supplier, do_date, supplier_reference } = req.body;
    const { data, error } = await supabase.from("supplier_deliveries")
      .update({ do_number, supplier, do_date, supplier_reference })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ delivery: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/supplier-deliveries/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    await supabase.from("do_review").delete().eq("supplier_delivery_id", req.params.id);
    const { error } = await supabase.from("supplier_deliveries").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DO Review API ─────────────────────────────────────────────────
app.get("/do-review", async (req, res) => {
  const { data, error } = await supabase.from("do_review").select("*").eq("status", "Pending").order("created_at", { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.patch("/do-review/:id/resolve", async (req, res) => {
  const { id } = req.params;
  const { so_number, item_code, arrival_date } = req.body;
  if (so_number && item_code) {
    const date = arrival_date || new Date().toLocaleString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).split(",")[0].trim();
    const { data: orders } = await supabase.from("orders").select("id, items").eq("so_number", so_number).in("status", ["Pending", "In Progress"]);
    for (const order of (orders || [])) {
      const items = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
      const updated = items.map(oi => {
        if (oi.itemCode === item_code || (oi.itemName && oi.itemName.toLowerCase().includes(item_code.toLowerCase()))) return { ...oi, arrivalDate: date };
        return oi;
      });
      await supabase.from("orders").update({ items: JSON.stringify(updated) }).eq("id", order.id);
    }
  }
  const { error } = await supabase.from("do_review").update({ status: "Resolved" }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

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
    const isPublicCommand = message.text && ["/start", "/help", "4", "help"].includes(message.text.trim().toLowerCase());
    if (!isPublicCommand) {
      const telegramUser = await getTelegramUser(userId);
      if (!telegramUser) {
        await sendMessage(chatId, `❌ *Not Registered*

Your Telegram account is not linked to this system.

Please contact your manager to set up your account.`);
        return;
      }
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

    // Attach photo + company/branch + user attribution to draft for storage on save
    data.photoBase64 = base64Image;
    if (message._telegramUser?.company_id) data.companyId = message._telegramUser.company_id;
    if (message._telegramUser?.branch_id)  data.branchId  = message._telegramUser.branch_id;
    if (message._telegramUser?.id) {
      data.createdByUserId = message._telegramUser.id;
      // Default credited salesman to the submitter; refined below if OCR salesman matches another user
      data.mainSalesmanUserId = message._telegramUser.id;
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

// ── Product Master Routes ─────────────────────────────────────────

// ── Company Settings ─────────────────────────────────────────────
app.get("/company-settings", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ error: "company_id required" });
    const { data } = await supabase.from("company_settings").select("*").eq("company_id", company_id).maybeSingle();
    res.json({ settings: data || {} });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/company-settings", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { company_id } = req.user;
    const { company_name, registration_no, address, hotline, bank_account, branches_display, work_start, work_end, base_address, countries } = req.body;
    const row = { company_id, company_name, registration_no, address, hotline, bank_account, branches_display, work_start: work_start || "09:00", work_end: work_end || "18:00", base_address, countries: countries || null, updated_at: new Date().toISOString() };
    const { data: existing } = await supabase.from("company_settings").select("id").eq("company_id", company_id).maybeSingle();
    let result;
    if (existing) {
      const { data, error } = await supabase.from("company_settings").update(row).eq("id", existing.id).select().single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await supabase.from("company_settings").insert(row).select().single();
      if (error) throw error;
      result = data;
    }
    res.json({ settings: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Warehouses CRUD ──────────────────────────────────────────────
app.get("/warehouses", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ error: "company_id required" });
    const { data, error } = await supabase.from("warehouses").select("*").eq("company_id", company_id).eq("is_active", true).order("name");
    if (error) throw error;
    res.json({ warehouses: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/warehouses", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { name, type, address, pic, contact } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const { data, error } = await supabase.from("warehouses")
      .insert({ company_id: req.user.company_id, name: name.trim(), type: type || "warehouse", address: address || null, pic: pic || null, contact: contact || null, is_active: true })
      .select().single();
    if (error) throw error;
    res.status(201).json({ warehouse: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/warehouses/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { name, type, address, pic, contact } = req.body;
    const { data, error } = await supabase.from("warehouses")
      .update({ name: name?.trim(), type, address, pic: pic || null, contact: contact || null }).eq("id", req.params.id).eq("company_id", req.user.company_id).select().single();
    if (error) throw error;
    res.json({ warehouse: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/warehouses/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    await supabase.from("warehouses").update({ is_active: false }).eq("id", req.params.id).eq("company_id", req.user.company_id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Inventory Routes ─────────────────────────────────────────────
async function adjustStock(company_id, warehouse_id, product_id, qty_delta, type, reference_type, reference_id, notes, created_by) {
  const { data: existing } = await supabase.from("inventory")
    .select("id, quantity").eq("warehouse_id", warehouse_id).eq("product_id", product_id).maybeSingle();
  const newQty = (existing?.quantity || 0) + qty_delta;
  if (existing) {
    await supabase.from("inventory").update({ quantity: newQty, updated_at: new Date().toISOString() }).eq("id", existing.id);
  } else {
    await supabase.from("inventory").insert({ company_id, warehouse_id, product_id, quantity: newQty, reserved_qty: 0 });
  }
  await supabase.from("stock_movements").insert({
    company_id, warehouse_id, product_id, type, quantity: qty_delta,
    reference_type, reference_id, notes, created_by,
  });
  return newQty;
}

async function recordLeadTime(company_id, supplier_id, product_id, po_created_at, do_received_at) {
  if (!po_created_at || !do_received_at) return;
  const lead_days = Math.round((new Date(do_received_at) - new Date(po_created_at)) / (1000 * 60 * 60 * 24));
  if (lead_days < 0 || lead_days > 365) return;
  await supabase.from("supplier_lead_times").insert({
    company_id, supplier_id: supplier_id || null, product_id: product_id || null,
    po_created_at, do_received_at, lead_days,
  });
}

app.get("/inventory", async (req, res) => {
  try {
    const { company_id, warehouse_id, low_stock } = req.query;
    if (!company_id) return res.status(400).json({ error: "company_id required" });
    let query = supabase.from("inventory")
      .select("*, products(id, code, name, color, size, unit_cost, reorder_point, suppliers(id, name)), warehouses(id, name, type)")
      .eq("company_id", company_id);
    if (warehouse_id) query = query.eq("warehouse_id", warehouse_id);
    const { data, error } = await query;
    if (error) throw error;
    let items = data || [];
    if (low_stock === "true") {
      items = items.filter(i => i.products && i.quantity <= (i.products.reorder_point || 0));
    }
    res.json({ inventory: items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/inventory/summary", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ error: "company_id required" });
    const { data, error } = await supabase.from("inventory")
      .select("product_id, quantity, reserved_qty, products(id, code, name, color, size, reorder_point)")
      .eq("company_id", company_id);
    if (error) throw error;
    const grouped = {};
    (data || []).forEach(r => {
      if (!grouped[r.product_id]) grouped[r.product_id] = { product: r.products, total_qty: 0, total_reserved: 0 };
      grouped[r.product_id].total_qty += r.quantity || 0;
      grouped[r.product_id].total_reserved += r.reserved_qty || 0;
    });
    res.json({ summary: Object.values(grouped) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/inventory/adjust", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { warehouse_id, product_id, quantity, notes } = req.body;
    if (!warehouse_id || !product_id || quantity == null) return res.status(400).json({ error: "warehouse_id, product_id, quantity required" });
    const { data: current } = await supabase.from("inventory")
      .select("quantity").eq("warehouse_id", warehouse_id).eq("product_id", product_id).maybeSingle();
    const delta = Number(quantity) - (current?.quantity || 0);
    const newQty = await adjustStock(req.user.company_id, warehouse_id, product_id, delta, "adjustment", "adjustment", null, notes || "Manual adjustment", req.user.id);
    res.json({ ok: true, new_quantity: newQty });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/inventory/transfer", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { from_warehouse_id, to_warehouse_id, product_id, quantity, notes } = req.body;
    if (!from_warehouse_id || !to_warehouse_id || !product_id || !quantity) return res.status(400).json({ error: "Missing fields" });
    const qty = Number(quantity);
    if (qty <= 0) return res.status(400).json({ error: "Quantity must be positive" });
    const { data: fromStock } = await supabase.from("inventory")
      .select("quantity").eq("warehouse_id", from_warehouse_id).eq("product_id", product_id).maybeSingle();
    if ((fromStock?.quantity || 0) < qty) return res.status(400).json({ error: `Insufficient stock (have ${fromStock?.quantity || 0})` });
    await adjustStock(req.user.company_id, from_warehouse_id, product_id, -qty, "transfer", "transfer", to_warehouse_id, `Transfer to ${to_warehouse_id}`, req.user.id);
    await adjustStock(req.user.company_id, to_warehouse_id, product_id, qty, "transfer", "transfer", from_warehouse_id, `Transfer from ${from_warehouse_id}`, req.user.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/stock-movements", async (req, res) => {
  try {
    const { company_id, warehouse_id, type, limit: lim } = req.query;
    if (!company_id) return res.status(400).json({ error: "company_id required" });
    let query = supabase.from("stock_movements")
      .select("*, products(code, name), warehouses(name)")
      .eq("company_id", company_id)
      .order("created_at", { ascending: false })
      .limit(Number(lim) || 100);
    if (warehouse_id) query = query.eq("warehouse_id", warehouse_id);
    if (type) query = query.eq("type", type);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ movements: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /inventory/import — bulk import from xlsx/csv
app.post("/inventory/import", requireRole(MANAGE_ROLES), upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const { warehouse_id } = req.body;
    if (!file || !warehouse_id) return res.status(400).json({ error: "file and warehouse_id required" });
    const XLSX = require("xlsx");
    const wb = XLSX.read(file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

    const company_id = req.user.company_id;
    let imported = 0, skipped = 0, errors = [];

    for (const row of rows) {
      const code = String(row.code || row.Code || row.product_code || row.SKU || "").trim().toUpperCase();
      const name = String(row.name || row.Name || row.product_name || "").trim();
      const qty = Number(row.quantity || row.qty || row.Quantity || row.Qty || 0);
      if (!code && !name) { skipped++; continue; }
      if (qty <= 0) { skipped++; continue; }

      // Find product by code (and optionally name/size/color)
      let query = supabase.from("products").select("id").eq("company_id", company_id);
      if (code) query = query.eq("code", code);
      else query = query.ilike("name", `%${name}%`);
      const { data: prods } = await query.limit(1);

      if (!prods || prods.length === 0) { errors.push(`${code || name}: product not found`); skipped++; continue; }

      await adjustStock(company_id, warehouse_id, prods[0].id, qty, "adjustment", "adjustment", null, "Bulk import", req.user.id);
      imported++;
    }

    res.json({ imported, skipped, errors: errors.slice(0, 20) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Spec Options Library ─────────────────────────────────────────
app.get("/spec-options", async (req, res) => {
  try {
    const { company_id, label } = req.query;
    if (!company_id) return res.status(400).json({ error: "company_id required" });
    let query = supabase.from("spec_options").select("*").eq("company_id", company_id).order("label").order("value");
    if (label) query = query.eq("label", label);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ options: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/spec-options/pending", async (req, res) => {
  try {
    const { company_id } = req.query;
    if (!company_id) return res.status(400).json({ error: "company_id required" });
    const { data, error } = await supabase.from("spec_options").select("*")
      .eq("company_id", company_id).eq("is_approved", false).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ options: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/spec-options", requireRole(["master", "manager", "company_admin", "salesman"]), async (req, res) => {
  try {
    const { label, value, is_approved } = req.body;
    if (!label || !value) return res.status(400).json({ error: "label and value required" });
    const isAdmin = ["master", "manager", "company_admin"].includes(req.user.role);
    const { data, error } = await supabase.from("spec_options")
      .upsert({ company_id: req.user.company_id, label: label.trim(), value: value.trim(), is_approved: is_approved !== undefined ? is_approved : isAdmin, added_by: req.user.id },
        { onConflict: "company_id,label,value", ignoreDuplicates: true })
      .select().single();
    if (error && error.code !== "23505") throw error;
    res.json({ option: data || { label, value } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/spec-options/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { value } = req.body;
    const { data, error } = await supabase.from("spec_options").update({ value: value.trim() })
      .eq("id", req.params.id).eq("company_id", req.user.company_id).select().single();
    if (error) throw error;
    res.json({ option: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/spec-options/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { error } = await supabase.from("spec_options").delete().eq("id", req.params.id).eq("company_id", req.user.company_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/spec-options/:id/approve", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { data, error } = await supabase.from("spec_options").update({ is_approved: true })
      .eq("id", req.params.id).eq("company_id", req.user.company_id).select().single();
    if (error) throw error;
    res.json({ option: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Branches CRUD ────────────────────────────────────────────────
app.get("/branches", async (req, res) => {
  try {
    const { company_id } = req.query;
    let query = supabase.from("branches").select("id, name, company_id").order("name");
    if (company_id) query = query.eq("company_id", company_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ branches: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/branches", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { name, code } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const branchCode = code || name.trim().toUpperCase().replace(/\s+/g, "_").slice(0, 20);
    const { data, error } = await supabase.from("branches").insert({ company_id: req.user.company_id, name: name.trim(), code: branchCode }).select().single();
    if (error) throw error;
    res.status(201).json({ branch: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/branches/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { name } = req.body;
    const { data, error } = await supabase.from("branches").update({ name: name.trim() }).eq("id", req.params.id).eq("company_id", req.user.company_id).select().single();
    if (error) throw error;
    res.json({ branch: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/branches/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { error } = await supabase.from("branches").delete().eq("id", req.params.id).eq("company_id", req.user.company_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /suppliers ───────────────────────────────────────────────
app.get("/suppliers", async (req, res) => {
  try {
    const { company_id } = req.query;
    let query = supabase.from("suppliers").select("id, name, code, contact, cost_divisor, color_mode, is_active, created_at").order("name");
    if (company_id) query = query.eq("company_id", company_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ suppliers: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Parse an incoming cost_divisor value → positive number, or null (= no derived costing)
const parseCostDivisor = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Colour interpretation per supplier: "split" → "A / B" means two colour variants;
// "combined" (default) → "A/B" is one two-tone colour kept as-is.
const parseColorMode = (v) => (v === "split" ? "split" : "combined");

app.post("/suppliers", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { name, code, contact, cost_divisor, color_mode } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const { data, error } = await supabase
      .from("suppliers")
      .insert({ company_id: req.user.company_id, name: name.trim(), code: code?.trim() || null, contact: contact || null, cost_divisor: parseCostDivisor(cost_divisor), color_mode: parseColorMode(color_mode) })
      .select().single();
    if (error) throw error;
    res.status(201).json({ supplier: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/suppliers/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { name, code, contact, cost_divisor, color_mode, is_active } = req.body;
    const patch = {};
    if (name !== undefined) patch.name = name.trim();
    if (code !== undefined) patch.code = code?.trim() || null;
    if (contact !== undefined) patch.contact = contact || null;
    if (cost_divisor !== undefined) patch.cost_divisor = parseCostDivisor(cost_divisor);
    if (color_mode !== undefined) patch.color_mode = parseColorMode(color_mode);
    if (is_active !== undefined) patch.is_active = is_active;
    const { data, error } = await supabase
      .from("suppliers")
      .update(patch)
      .eq("id", req.params.id).eq("company_id", req.user.company_id)
      .select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Supplier not found" });
    res.json({ supplier: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /suppliers/:id — blocked when products reference it unless ?force=true,
// in which case those products are unassigned (supplier_id set to null) first.
app.delete("/suppliers/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const id = req.params.id;
    const force = req.query.force === "true";
    const { count } = await supabase.from("products")
      .select("id", { count: "exact", head: true })
      .eq("company_id", company_id).eq("supplier_id", id);
    const productCount = count || 0;
    if (productCount > 0 && !force) {
      return res.status(409).json({ error: "Supplier is used by products", product_count: productCount });
    }
    if (productCount > 0) {
      await supabase.from("products").update({ supplier_id: null }).eq("company_id", company_id).eq("supplier_id", id);
    }
    const { error } = await supabase.from("suppliers").delete().eq("id", id).eq("company_id", company_id);
    if (error) throw error;
    res.json({ ok: true, products_unassigned: productCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /categories ──────────────────────────────────────────────
app.get("/categories", async (req, res) => {
  try {
    const { company_id } = req.query;
    let query = supabase.from("product_categories").select("id, name, parent_id, spec_labels, created_at").order("name");
    if (company_id) query = query.eq("company_id", company_id);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ categories: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/categories", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { name, parent_id } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const { data, error } = await supabase
      .from("product_categories")
      .insert({ company_id: req.user.company_id, name: name.trim(), parent_id: parent_id || null })
      .select().single();
    if (error) throw error;
    res.status(201).json({ category: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/categories/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { name, parent_id } = req.body;
    const { spec_labels } = req.body;
    const update = { name: name.trim(), parent_id: parent_id || null };
    if (spec_labels !== undefined) update.spec_labels = spec_labels;
    const { data, error } = await supabase.from("product_categories").update(update).eq("id", req.params.id).eq("company_id", req.user.company_id).select().single();
    if (error) throw error;
    res.json({ category: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/categories/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    await supabase.from("products").update({ category_id: null }).eq("category_id", req.params.id).eq("company_id", req.user.company_id);
    const { error } = await supabase.from("product_categories").delete().eq("id", req.params.id).eq("company_id", req.user.company_id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /products ────────────────────────────────────────────────
app.get("/products", async (req, res) => {
  try {
    const { company_id, search, supplier_id, category_id, is_active, page = 1, limit = 50 } = req.query;
    let query = supabase
      .from("products")
      .select("id, code, name, description, color, size, unit_cost, unit_price, is_standard, is_customizable, reorder_point, is_active, created_at, suppliers(id,name), product_categories(id,name)", { count: "exact" })
      .order("name")
      .range((page - 1) * limit, page * limit - 1);
    if (company_id) query = query.eq("company_id", company_id);
    if (search) query = query.or(`name.ilike.%${search}%,code.ilike.%${search}%`);
    if (supplier_id) query = query.eq("supplier_id", supplier_id);
    if (category_id) query = query.eq("category_id", category_id);
    if (is_active === "true") query = query.eq("is_active", true);
    if (is_active === "false") query = query.eq("is_active", false);
    const { data, error, count } = await query;
    if (error) throw error;
    res.json({ products: data || [], total: count || 0, page: Number(page), limit: Number(limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/products", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { code, name, description, color, size, supplier_id, category_id, unit_cost, unit_price, is_standard, is_customizable, reorder_point } = req.body;
    if (!code || !name) return res.status(400).json({ error: "code and name are required" });
    const { data, error } = await supabase.from("products")
      .insert({ company_id: req.user.company_id, code: code.trim().toUpperCase(), name: name.trim(), description: description || null, color: color || null, size: size || null, supplier_id: supplier_id || null, category_id: category_id || null, unit_cost: unit_cost ?? null, unit_price: unit_price ?? null, is_standard: is_standard !== false, is_customizable: is_customizable === true, reorder_point: reorder_point ?? 0, is_active: true })
      .select().single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: `Product code "${code}"${size ? ` (size "${size}")` : ""} already exists` });
      throw error;
    }
    res.status(201).json({ product: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/products/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { code, name, description, color, size, supplier_id, category_id, unit_cost, unit_price, is_standard, is_customizable, reorder_point, is_active } = req.body;
    const { data, error } = await supabase.from("products")
      .update({ code: code?.trim().toUpperCase(), name: name?.trim(), description, color: color || null, size: size || null, supplier_id: supplier_id || null, category_id: category_id || null, unit_cost: unit_cost ?? null, unit_price: unit_price ?? null, is_standard, is_customizable, reorder_point, is_active })
      .eq("id", req.params.id).eq("company_id", req.user.company_id)
      .select().single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: `Product code "${code}"${size ? ` (size "${size}")` : ""} already exists` });
      throw error;
    }
    if (!data) return res.status(404).json({ error: "Product not found" });
    res.json({ product: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/products/:id/toggle", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { data: existing } = await supabase.from("products").select("is_active").eq("id", req.params.id).eq("company_id", req.user.company_id).single();
    if (!existing) return res.status(404).json({ error: "Product not found" });
    const { data, error } = await supabase.from("products").update({ is_active: !existing.is_active }).eq("id", req.params.id).select("id, is_active").single();
    if (error) throw error;
    res.json({ product: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /products/:id — remove a product (unlinks any catalogue import rows first)
app.delete("/products/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const id = req.params.id;
    await supabase.from("catalogue_import_rows").update({ product_id: null }).eq("product_id", id);
    const { error } = await supabase.from("products").delete().eq("id", id).eq("company_id", company_id);
    if (error) {
      if (error.code === "23503") return res.status(409).json({ error: "Product is referenced elsewhere and can't be deleted" });
      throw error;
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /products/bulk-delete — remove many products at once. body: { ids: [] }
app.post("/products/bulk-delete", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids must be a non-empty array" });
    await supabase.from("catalogue_import_rows").update({ product_id: null }).in("product_id", ids);
    const { data, error } = await supabase.from("products").delete().eq("company_id", company_id).in("id", ids).select("id");
    if (error) {
      if (error.code === "23503") return res.status(409).json({ error: "Some products are referenced elsewhere and can't be deleted" });
      throw error;
    }
    res.json({ ok: true, deleted: data?.length || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /products/bulk — apply the same changes to many products at once.
// body: { ids: [], set: { supplier_id?, category_id?, is_active?, is_standard?, reorder_point? }, cost_divisor? }
// Provided keys in `set` are written to every product; cost_divisor (when > 0)
// recomputes each product's unit_cost from its own unit_price.
app.patch("/products/bulk", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const company_id = req.user.company_id;
    const { ids, set = {}, cost_divisor } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids must be a non-empty array" });

    const patch = {};
    if (set.supplier_id !== undefined) patch.supplier_id = set.supplier_id || null;
    if (set.category_id !== undefined) patch.category_id = set.category_id || null;
    if (set.is_active !== undefined) patch.is_active = set.is_active;
    if (set.is_standard !== undefined) patch.is_standard = set.is_standard;
    if (set.reorder_point !== undefined) patch.reorder_point = Number(set.reorder_point) || 0;
    if (set.unit_cost !== undefined) patch.unit_cost = set.unit_cost != null ? Number(set.unit_cost) : null;
    if (set.unit_price !== undefined) patch.unit_price = set.unit_price != null ? Number(set.unit_price) : null;
    if (set.is_customizable !== undefined) patch.is_customizable = set.is_customizable;

    let updated = 0;
    if (Object.keys(patch).length > 0) {
      const { data, error } = await supabase.from("products").update(patch).eq("company_id", company_id).in("id", ids).select("id");
      if (error) throw error;
      updated = data?.length || 0;
    }

    const divisor = parseCostDivisor(cost_divisor);
    if (divisor) {
      const { data: prods } = await supabase.from("products").select("id, unit_price").eq("company_id", company_id).in("id", ids);
      const withPrice = (prods || []).filter(p => p.unit_price != null);
      await Promise.all(withPrice.map(p =>
        supabase.from("products").update({ unit_cost: Math.round((p.unit_price / divisor) * 100) / 100 }).eq("id", p.id).eq("company_id", company_id)
      ));
      updated = Math.max(updated, withPrice.length);
    }

    if (Object.keys(patch).length === 0 && !divisor) return res.status(400).json({ error: "No changes provided" });
    res.json({ ok: true, updated, count: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Catalogue Import Routes ───────────────────────────────────────
const XLSX = require("xlsx");
const pdfParse = require("pdf-parse");

const normaliseImportRow = (raw) => {
  const find = (...keys) => { for (const k of keys) { const v = raw[k] ?? raw[k?.toLowerCase()] ?? raw[k?.toUpperCase()]; if (v !== undefined && v !== null && v !== "") return String(v).trim(); } return ""; };
  const toNum = (v) => { const n = parseFloat(String(v).replace(/[^0-9.]/g, "")); return isNaN(n) ? null : n; };
  return {
    product_code: find("code","Code","item_code","Item Code","SKU","sku","Model","model").toUpperCase(),
    product_name: find("name","Name","item_name","Item Name","Product","product","Description","description"),
    color:        find("color","Color","Colour","colour","color_code","Color Code"),
    size:         find("size","Size","dimension","Dimension","dimensions","Dimensions","variant","Variant","option","Option","spec","Spec"),
    is_customizable: ["true","yes","1"].includes(find("customizable","Customizable","custom","Custom","is_customizable").toLowerCase()),
    category_name: find("category","Category","type","Type","product_type","Product Type","group","Group"),
    supplier_name: find("supplier","Supplier","company","Company","brand","Brand","manufacturer","Manufacturer"),
    unit_cost:    toNum(find("cost","Cost","unit_cost","Unit Cost","Buy Price","buy_price","purchase_price")),
    unit_price:   toNum(find("price","Price","unit_price","Unit Price","Sell Price","sell_price","selling_price")),
  };
};

const CATALOGUE_VISION_PROMPT = `You are a catalogue parser. Extract EVERY SINGLE product/row from this catalogue page. Do NOT skip or summarize — output ALL rows.
Return ONLY a JSON array (no markdown, no prose) where each element has exactly these keys:
  code (string, uppercase), name (string), color (string or null), size (string or null — the size/dimensions/variant label), customizable (boolean — true if the product supports custom sizing or dimensions, e.g. items offered in multiple sizes or with "CUSTOMIZE" mentioned), category (string or null — the product category/type, e.g. "Sofa", "Bed Frame", "Dining Table", "Wardrobe", "Lighting"), supplier (string or null — the brand/company/manufacturer), unit_cost (number or null), unit_price (number or null)
IMPORTANT: If one product (same code) is offered in several sizes/variants at different prices, output a SEPARATE entry for EACH size — repeat the same code and name, and put that size's dimensions/label in "size" with its own unit_price.
IMPORTANT: Include add-ons, accessories, pillows, upgrades, motors — every line item with a price is a separate product entry. Do NOT skip any row.
Example: [
  {"code":"SD886","name":"Study Desk","color":"Natural / Walnut","size":"W800 x D600 x H750mm (1 Drawer)","customizable":false,"category":"Desk","supplier":null,"unit_cost":null,"unit_price":690},
  {"code":"2222","name":"Sofa 4FT","color":null,"size":"W48\" D41\" H17\"","customizable":true,"category":"Sofa","supplier":null,"unit_cost":null,"unit_price":672}
]
Do NOT include any explanation. Return the JSON array only.`;

const parseAiJson = (text) => {
  const clean = text.trim().replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const parsed = JSON.parse(clean);
  return (Array.isArray(parsed) ? parsed : parsed.items ?? parsed.products ?? [])
    .map(normaliseImportRow).filter(r => r.product_code || r.product_name);
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Derive unit_cost from unit_price when the supplier uses a divisor-based cost
// (e.g. cost_divisor = 3 → a catalogue price of RM 2000 yields a cost of RM 666.67).
const applyCostDivisor = (row, costDivisor) => {
  if (costDivisor && costDivisor > 0 && row.unit_price != null) {
    return { ...row, unit_cost: Math.round((row.unit_price / costDivisor) * 100) / 100 };
  }
  return row;
};

// Split a colour string like "Natural / Walnut" into its individual colours.
const splitColours = (color) => String(color || "").split("/").map(c => c.trim()).filter(Boolean);

// Variant identity: a product is unique per company on code + size + colour.
const variantKey = (code, name, size, color) =>
  `${(code || "").toUpperCase()}||${(name || "").trim().toLowerCase()}||${(size || "").trim().toLowerCase()}||${(color || "").trim().toLowerCase()}`;

// When the supplier treats "A / B" as separate colour options, expand each row
// with a multi-colour value into one row per colour. Otherwise keep rows as-is.
const expandColourVariants = (rows, colorMode) => {
  if (colorMode !== "split") return rows;
  const out = [];
  for (const r of rows) {
    const colours = splitColours(r.color);
    if (colours.length > 1) colours.forEach(c => out.push({ ...r, color: c }));
    else out.push(r);
  }
  return out;
};

// Finish a job: duplicate-check, insert staging rows, set status to review
async function finaliseJob(jobId, companyId, parsedRows, costDivisor = null, colorMode = "combined") {
  if (parsedRows.length === 0) {
    await supabase.from("catalogue_import_jobs").update({ status: "failed", error_message: "No products found in file" }).eq("id", jobId);
    return;
  }
  const rows = expandColourVariants(parsedRows, colorMode);
  const codes = rows.map(r => r.product_code).filter(Boolean);
  let existingKeys = new Set();
  if (codes.length > 0) {
    const { data: existing } = await supabase.from("products").select("code, name, size, color").eq("company_id", companyId).in("code", codes);
    existingKeys = new Set((existing || []).map(p => variantKey(p.code, p.name, p.size, p.color)));
  }
  const stagingRows = rows.map(r => applyCostDivisor(r, costDivisor)).map(r => ({
    job_id: jobId, raw_data: r, product_code: r.product_code || null, product_name: r.product_name || null,
    color: r.color || null, size: r.size || null, is_customizable: r.is_customizable || false, category_name: r.category_name || null, supplier_name: r.supplier_name || null,
    unit_cost: r.unit_cost, unit_price: r.unit_price, action: existingKeys.has(variantKey(r.product_code, r.product_name, r.size, r.color)) ? "duplicate" : "import",
  }));
  const { error: rowsError } = await supabase.from("catalogue_import_rows").insert(stagingRows).select();
  if (rowsError) throw new Error(rowsError.message);
  await supabase.from("catalogue_import_jobs").update({ status: "review", ai_raw_output: parsedRows, pages_processed: null }).eq("id", jobId);
}

// Background async processor for PDF and image files
async function processJobAsync(jobId, fileBuffer) {
  try {
    const { data: job } = await supabase.from("catalogue_import_jobs")
      .select("*").eq("id", jobId).single();
    if (!job || job.status !== "processing") return;

    const buffer = fileBuffer;

    let parsedRows = [];

    if (job.parse_method === "text_layer") {
      // Text-based PDF: chunk text and send to GPT-4o as text
      const pdfData = await pdfParse(buffer);
      const fullText = pdfData.text || "";
      const CHUNK_SIZE = 100000;
      const chunks = [];
      for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
        chunks.push(fullText.slice(i, i + CHUNK_SIZE));
      }
      if (chunks.length === 0) chunks.push("");

      await supabase.from("catalogue_import_jobs").update({ pages_total: chunks.length, pages_processed: 0 }).eq("id", jobId);

      for (let i = 0; i < chunks.length; i++) {
        try {
          const resp = await openai.chat.completions.create({ model: "gpt-4o", max_tokens: 16000, messages: [{ role: "user", content: [
            { type: "text", text: CATALOGUE_VISION_PROMPT + "\n\nCatalogue text:\n" + chunks[i] },
          ] }] });
          const rows = parseAiJson(resp.choices[0].message.content);
          parsedRows.push(...rows);
        } catch (chunkErr) {
          console.error(`Job ${jobId} text chunk ${i + 1} error (skipping):`, chunkErr.message);
        }
        await supabase.from("catalogue_import_jobs").update({ pages_processed: i + 1 }).eq("id", jobId);
        if (i < chunks.length - 1) await sleep(1000);
      }
    } else {
      // image_ocr: render PDF pages to PNG or use single image, batched 4 pages per API call
      const isPdf = job.source_type === "pdf";
      const pageBuffers = [];
      const PAGES_PER_BATCH = 1;
      const MAX_PAGES = 200;

      if (isPdf) {
        // Split PDF into batches of single-page PDFs using pdf-lib
        const { PDFDocument } = require("pdf-lib");
        const srcDoc = await PDFDocument.load(buffer);
        const totalPages = Math.min(srcDoc.getPageCount(), MAX_PAGES);

        const totalBatches = Math.ceil(totalPages / PAGES_PER_BATCH);
        await supabase.from("catalogue_import_jobs").update({ pages_total: totalBatches, pages_processed: 0 }).eq("id", jobId);

        for (let b = 0; b < totalBatches; b++) {
          const startPage = b * PAGES_PER_BATCH;
          const endPage = Math.min(startPage + PAGES_PER_BATCH, totalPages);
          try {
            // Create a small PDF with just this batch of pages
            const batchDoc = await PDFDocument.create();
            const copied = await batchDoc.copyPages(srcDoc, Array.from({ length: endPage - startPage }, (_, i) => startPage + i));
            copied.forEach(p => batchDoc.addPage(p));
            const batchPdfBytes = await batchDoc.save();
            const b64 = Buffer.from(batchPdfBytes).toString("base64");

            const resp = await openai.chat.completions.create({
              model: "gpt-4o", max_tokens: 16000,
              messages: [{ role: "user", content: [
                { type: "file", file: { filename: "catalogue.pdf", file_data: `data:application/pdf;base64,${b64}` } },
                { type: "text", text: CATALOGUE_VISION_PROMPT },
              ] }],
            });
            const rows = parseAiJson(resp.choices[0].message.content);
            parsedRows.push(...rows);
          } catch (batchErr) {
            console.error(`Job ${jobId} batch ${b + 1}/${totalBatches} error (skipping):`, batchErr.message);
          }
          await supabase.from("catalogue_import_jobs").update({ pages_processed: b + 1 }).eq("id", jobId);
          if (b < totalBatches - 1) await sleep(2000);
        }
      } else {
        // Single image
        const totalBatches = 1;
        await supabase.from("catalogue_import_jobs").update({ pages_total: totalBatches, pages_processed: 0 }).eq("id", jobId);
        try {
          const b64 = buffer.toString("base64");
          const resp = await openai.chat.completions.create({
            model: "gpt-4o", max_tokens: 16000,
            messages: [{ role: "user", content: [
              { type: "image_url", image_url: { url: `data:image/png;base64,${b64}`, detail: "high" } },
              { type: "text", text: CATALOGUE_VISION_PROMPT },
            ] }],
          });
          const rows = parseAiJson(resp.choices[0].message.content);
          parsedRows.push(...rows);
        } catch (imgErr) {
          console.error(`Job ${jobId} image error:`, imgErr.message);
        }
        await supabase.from("catalogue_import_jobs").update({ pages_processed: 1 }).eq("id", jobId);
      }
    }

    await finaliseJob(jobId, job.company_id, parsedRows, job.cost_divisor, job.color_mode);
  } catch (err) {
    console.error(`processJobAsync ${jobId} fatal error:`, err);
    await supabase.from("catalogue_import_jobs").update({ status: "failed", error_message: err.message }).eq("id", jobId);
  }
}

app.post("/catalogue-import/upload", requireRole(MANAGE_ROLES), upload.single("file"), async (req, res) => {
  try {
    const { company_id, id: created_by } = req.user;
    const { supplier_id, category_id } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    // Resolve costing rule for this import. A cost_divisor in the request is an
    // explicit choice (number = derive cost from price, blank = use catalogue cost)
    // and is persisted on the supplier so it is remembered next time. When the
    // field is absent, fall back to the supplier's saved default.
    let costDivisor = null;
    if (req.body.cost_divisor !== undefined) {
      costDivisor = parseCostDivisor(req.body.cost_divisor);
      // Only persist a real divisor. Choosing "use catalogue cost" (blank) must
      // NOT wipe the supplier's saved rule — clearing is done from supplier settings.
      if (supplier_id && costDivisor) {
        await supabase.from("suppliers").update({ cost_divisor: costDivisor }).eq("id", supplier_id).eq("company_id", company_id);
      }
    } else if (supplier_id) {
      const { data: sup } = await supabase.from("suppliers").select("cost_divisor").eq("id", supplier_id).eq("company_id", company_id).single();
      costDivisor = sup?.cost_divisor ?? null;
    }

    // Resolve colour mode from the selected supplier (default: combined = no split)
    let colorMode = "combined";
    if (supplier_id) {
      const { data: supC } = await supabase.from("suppliers").select("color_mode").eq("id", supplier_id).eq("company_id", company_id).single();
      colorMode = supC?.color_mode === "split" ? "split" : "combined";
    }

    const ext = file.originalname.split(".").pop().toLowerCase();
    const isXlsx = ["xlsx", "xls", "csv"].includes(ext);
    const isImage = file.mimetype.startsWith("image/");
    const source_type = isXlsx ? "xlsx" : ext === "pdf" ? "pdf" : "photo";

    // Upload to Supabase Storage (non-fatal)
    let publicUrl = null;
    try {
      const storagePath = `catalogue-imports/${company_id}/${Date.now()}-${file.originalname}`;
      await supabase.storage.from("catalogue-imports").upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
      const { data } = supabase.storage.from("catalogue-imports").getPublicUrl(storagePath);
      publicUrl = data?.publicUrl || null;
    } catch (storageErr) {
      console.error("Storage upload error (non-fatal):", storageErr.message);
    }

    // Determine parse_method for PDF
    let parseMethod = null;
    if (!isXlsx && !isImage) {
      try {
        const pdfData = await pdfParse(file.buffer);
        const textLen = (pdfData.text || "").length;
        const pageCount = pdfData.numpages || 1;
        // Prefer image_ocr for tabular/catalogue PDFs — text extraction loses table structure
        // Only use text_layer for very text-heavy documents (>2000 chars/page avg)
        parseMethod = (textLen / pageCount) > 2000 ? "text_layer" : "image_ocr";
      } catch {
        parseMethod = "image_ocr";
      }
    } else if (isImage) {
      parseMethod = "image_ocr";
    }

    // Create job
    const { data: job, error: jobError } = await supabase.from("catalogue_import_jobs")
      .insert({
        company_id, supplier_id: supplier_id || null, category_id: category_id || null,
        source_type, source_url: publicUrl || null, status: "processing",
        parse_method: parseMethod, cost_divisor: costDivisor, color_mode: colorMode, started_at: new Date().toISOString(), created_by,
      })
      .select().single();
    if (jobError) return res.status(500).json({ error: jobError.message });

    // XLSX: synchronous parse, return rows immediately
    if (isXlsx) {
      try {
        const wb = XLSX.read(file.buffer, { type: "buffer" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json(ws, { defval: "" });
        const parsedRows = rawRows.map(normaliseImportRow).filter(r => r.product_code || r.product_name);
        await finaliseJob(job.id, company_id, parsedRows, costDivisor, colorMode);
        const { data: updatedJob } = await supabase.from("catalogue_import_jobs")
          .select("*, catalogue_import_rows(*)").eq("id", job.id).single();
        return res.json({ job_id: job.id, status: "review", rows: updatedJob?.catalogue_import_rows || [] });
      } catch (parseErr) {
        await supabase.from("catalogue_import_jobs").update({ status: "failed", error_message: parseErr.message }).eq("id", job.id);
        return res.status(422).json({ error: "Failed to parse file: " + parseErr.message });
      }
    }

    // PDF / Image: fire background processing, return immediately
    processJobAsync(job.id, file.buffer);
    res.json({ job_id: job.id, status: "processing" });
  } catch (err) {
    console.error("catalogue-import/upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/catalogue-import/:job_id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { data: job, error } = await supabase.from("catalogue_import_jobs")
      .select("*, catalogue_import_rows(*)")
      .eq("id", req.params.job_id).eq("company_id", req.user.company_id).single();
    if (error || !job) return res.status(404).json({ error: "Job not found" });

    // Timeout guard: if processing for more than 15 minutes, mark as failed
    if (job.status === "processing" && job.started_at) {
      const elapsed = Date.now() - new Date(job.started_at).getTime();
      if (elapsed > 15 * 60 * 1000) {
        await supabase.from("catalogue_import_jobs")
          .update({ status: "failed", error_message: "Processing timed out — please re-upload" })
          .eq("id", job.id);
        job.status = "failed";
        job.error_message = "Processing timed out — please re-upload";
      }
    }

    res.json({ job });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/catalogue-import/:job_id/rows", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: "rows must be an array" });
    const { data: job } = await supabase.from("catalogue_import_jobs").select("id").eq("id", req.params.job_id).eq("company_id", req.user.company_id).single();
    if (!job) return res.status(404).json({ error: "Job not found" });
    await Promise.all(rows.map(r => supabase.from("catalogue_import_rows").update({ product_code: r.product_code?.toUpperCase(), product_name: r.product_name, color: r.color || null, size: r.size || null, is_customizable: r.is_customizable || false, category_name: r.category_name || null, supplier_name: r.supplier_name || null, unit_cost: r.unit_cost, unit_price: r.unit_price, action: r.action }).eq("id", r.id).eq("job_id", req.params.job_id)));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /catalogue-import/:job_id/rows/:row_id/split — split one review row whose
// colour holds several options (e.g. "Natural / Walnut") into one row per colour.
app.post("/catalogue-import/:job_id/rows/:row_id/split", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { job_id, row_id } = req.params;
    const { data: job } = await supabase.from("catalogue_import_jobs").select("id").eq("id", job_id).eq("company_id", req.user.company_id).single();
    if (!job) return res.status(404).json({ error: "Job not found" });
    const { data: row } = await supabase.from("catalogue_import_rows").select("*").eq("id", row_id).eq("job_id", job_id).single();
    if (!row) return res.status(404).json({ error: "Row not found" });

    const colours = splitColours(row.color);
    if (colours.length < 2) return res.status(400).json({ error: "Nothing to split — colour has a single value" });

    // First colour stays on the original row; the rest become new rows.
    await supabase.from("catalogue_import_rows").update({ color: colours[0] }).eq("id", row_id);
    const { id, created_at, ...rest } = row;
    const newRows = colours.slice(1).map(c => ({ ...rest, color: c, product_id: null, action: "import" }));
    await supabase.from("catalogue_import_rows").insert(newRows);

    const { data: allRows } = await supabase.from("catalogue_import_rows").select("*").eq("job_id", job_id);
    res.json({ ok: true, rows: allRows || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/catalogue-import/:job_id/commit", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { company_id } = req.user;
    const { data: job, error } = await supabase.from("catalogue_import_jobs").select("*, catalogue_import_rows(*)").eq("id", req.params.job_id).eq("company_id", company_id).single();
    if (error || !job) return res.status(404).json({ error: "Job not found" });
    if (job.status === "done") return res.status(409).json({ error: "Job already committed" });

    const toImport = (job.catalogue_import_rows || []).filter(r => r.action === "import");
    const skippedCount = (job.catalogue_import_rows || []).filter(r => r.action !== "import").length;

    // Re-check duplicates at commit time, keyed by code + size + colour
    const codes = toImport.map(r => r.product_code).filter(Boolean);
    const { data: existing } = await supabase.from("products").select("code, name, size, color").eq("company_id", company_id).in("code", codes);
    const existingKeys = new Set((existing || []).map(p => variantKey(p.code, p.name, p.size, p.color)));

    // Build supplier name → id lookup for per-row supplier assignment
    const { data: allSuppliers } = await supabase.from("suppliers").select("id, name").eq("company_id", company_id);
    const supplierMap = new Map((allSuppliers || []).map(s => [s.name.toLowerCase(), s.id]));

    // Build category name → id lookup; auto-create missing categories
    const { data: allCategories } = await supabase.from("product_categories").select("id, name").eq("company_id", company_id);
    const categoryMap = new Map((allCategories || []).map(c => [c.name.toLowerCase(), c.id]));
    const uniqueCatNames = [...new Set(toImport.map(r => r.category_name?.trim()).filter(Boolean))];
    for (const catName of uniqueCatNames) {
      if (!categoryMap.has(catName.toLowerCase())) {
        const { data: newCat } = await supabase.from("product_categories")
          .insert({ company_id, name: catName }).select("id, name").single();
        if (newCat) categoryMap.set(newCat.name.toLowerCase(), newCat.id);
      }
    }

    let imported = 0, skipped = skippedCount;
    const rowUpdates = [];

    for (const row of toImport) {
      if (!row.product_code || !row.product_name) { skipped++; rowUpdates.push({ id: row.id, action: "skip", error_message: "Missing code or name", product_id: null }); continue; }
      if (existingKeys.has(variantKey(row.product_code, row.product_name, row.size, row.color))) { console.log("Duplicate skip:", row.product_code, "| size:", row.size, "| color:", row.color); skipped++; rowUpdates.push({ id: row.id, action: "duplicate", product_id: null }); continue; }
      // Resolve supplier: per-row supplier_name > job-level supplier_id
      let supplierId = job.supplier_id || null;
      if (row.supplier_name) {
        const matched = supplierMap.get(row.supplier_name.toLowerCase());
        if (matched) supplierId = matched;
      }
      // Resolve category: per-row category_name > job-level category_id
      let categoryId = job.category_id || null;
      if (row.category_name) {
        const matched = categoryMap.get(row.category_name.toLowerCase());
        if (matched) categoryId = matched;
      }
      const { data: product, error: insertErr } = await supabase.from("products")
        .insert({ company_id, supplier_id: supplierId, category_id: categoryId, code: row.product_code, name: row.product_name, color: row.color || null, size: row.size || null, is_customizable: row.is_customizable || false, unit_cost: row.unit_cost, unit_price: row.unit_price, is_standard: true, reorder_point: 0, is_active: true })
        .select("id").single();
      if (insertErr) { console.error("Product insert error:", insertErr.code, insertErr.message, "| code:", row.product_code, "| size:", row.size, "| color:", row.color); skipped++; rowUpdates.push({ id: row.id, action: "skip", error_message: insertErr.message, product_id: null }); }
      else { imported++; rowUpdates.push({ id: row.id, action: "import", product_id: product.id }); }
      // Prevent two identical variants within the same batch from both inserting
      if (!insertErr) existingKeys.add(variantKey(row.product_code, row.product_name, row.size, row.color));
    }

    await Promise.all(rowUpdates.map(u => supabase.from("catalogue_import_rows").update({ action: u.action, product_id: u.product_id }).eq("id", u.id)));
    await supabase.from("catalogue_import_jobs").update({ status: "done", rows_imported: imported, rows_skipped: skipped }).eq("id", job.id);
    const errors = rowUpdates.filter(u => u.error_message).map(u => u.error_message);
    res.json({ imported, skipped, total: toImport.length + skippedCount, errors: [...new Set(errors)] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Generate Outbound DO ─────────────────────────────────────────
async function nextDONumber(company_id) {
  const now = new Date();
  const ymd = now.toISOString().slice(2, 10).replace(/-/g, "");
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const { count } = await supabase
    .from("delivery_notes")
    .select("id", { count: "exact", head: true })
    .eq("company_id", company_id)
    .gte("created_at", dayStart);
  return `DO${ymd}-${String((count || 0) + 1).padStart(3, "0")}`;
}

app.post("/sales-orders/:id/generate-do", requireRole(["master", "manager", "company_admin", "salesman"]), async (req, res) => {
  try {
    const { company_id } = req.user;
    const { item_ids, warehouse_id } = req.body;

    const { data: order } = await supabase.from("sales_orders")
      .select("*, sales_order_items(*)").eq("id", req.params.id).eq("company_id", company_id).single();
    if (!order) return res.status(404).json({ error: "Order not found" });

    let items = order.sales_order_items || [];
    if (Array.isArray(item_ids) && item_ids.length > 0) items = items.filter(i => item_ids.includes(i.id));
    if (items.length === 0) return res.status(400).json({ error: "No items selected" });

    const do_number = await nextDONumber(company_id);
    const { data: dn, error } = await supabase.from("delivery_notes").insert({
      company_id, do_number, sales_order_id: order.id,
      customer_name: order.customer_name, customer_address: order.customer_address,
      customer_contact: order.customer_contact, delivery_date: order.delivery_date,
      warehouse_id: warehouse_id || null, status: "pending",
      created_by: req.user.id,
    }).select().single();
    if (error) throw error;

    const dnItems = items.map(it => ({
      delivery_note_id: dn.id, sales_order_item_id: it.id,
      product_id: it.product_id, product_code: it.product_code, product_name: it.product_name,
      size: it.size, color: it.color, custom_dimensions: it.custom_dimensions,
      quantity: Number(it.quantity) || 1,
    }));
    const { error: itemsErr } = await supabase.from("delivery_note_items").insert(dnItems);
    if (itemsErr) throw itemsErr;

    res.json({ do_number: dn.do_number, delivery_note: dn, item_count: items.length });
  } catch (err) { console.error("generate-do error:", err); res.status(500).json({ error: err.message }); }
});

app.get("/delivery-notes", requireRole(["master", "manager", "company_admin", "salesman"]), async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase.from("delivery_notes")
      .select("*, delivery_note_items(*)")
      .eq("company_id", req.user.company_id)
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ notes: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/delivery-notes/:id/status", requireRole(["master", "manager", "company_admin", "salesman"]), async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabase.from("delivery_notes")
      .update({ status }).eq("id", req.params.id).eq("company_id", req.user.company_id)
      .select("id, status").single();
    if (error) throw error;
    res.json({ note: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Web DO Upload ────────────────────────────────────────────────
// Reuses the same OCR + matching logic as the Telegram flow
app.post("/do-upload", requireRole(["master", "manager", "company_admin", "salesman"]), upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    const base64Image = file.buffer.toString("base64");

    let doData;
    try {
      doData = await extractDOFromImage(base64Image);
    } catch (err) {
      return res.status(422).json({ error: "Could not read the DO: " + err.message });
    }

    if (!doData.items || doData.items.length === 0) {
      return res.status(422).json({ error: "No items found in the DO" });
    }

    // Duplicate DO check
    if (doData.doNumber) {
      const { data: existing } = await supabase.from("supplier_deliveries")
        .select("id, do_number, supplier, created_at")
        .eq("do_number", doData.doNumber).limit(1);
      if (existing && existing.length > 0) {
        return res.status(409).json({ error: `DO #${doData.doNumber} already exists (uploaded ${new Date(existing[0].created_at).toLocaleDateString()})` });
      }
    }

    const arrivalDate = new Date().toLocaleString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).split(",")[0].trim();

    // Upload photo to storage
    let doPhotoUrl = null;
    const doMonth = new Date().toISOString().slice(0, 7);
    const safeSupplier = (doData.supplier || "unknown").replace(/[^a-zA-Z0-9]/g, "-").substring(0, 30);
    const doFilename = `${doMonth}/DO-${safeSupplier}-${Date.now()}.jpg`;
    doPhotoUrl = await uploadImageToStorage(base64Image, "supplier-do-photos", doFilename);

    // Create supplier_deliveries record
    const { data: supplierDelivery } = await supabase.from("supplier_deliveries").insert({
      do_number: doData.doNumber || null,
      supplier: doData.supplier || null,
      do_date: doData.doDate || arrivalDate,
      supplier_reference: doData.supplierReference || null,
      photo_url: doPhotoUrl,
      status: "Processed",
      company_id: req.user.company_id,
    }).select().single();
    const supplierDeliveryId = supplierDelivery?.id || null;

    const results = { updated: [], review: [], showroom: [] };

    for (const item of doData.items) {
      if (item.isShowroom || !item.soNumber) {
        await supabase.from("do_review").insert({
          do_number: doData.doNumber || null, supplier: doData.supplier || null,
          do_date: doData.doDate || arrivalDate, so_number: item.soNumber || null,
          item_code: item.itemCode || null, item_name: item.itemName || null,
          quantity: item.quantity || null, reason: item.isShowroom ? "showroom" : "no_so",
          status: "Pending", supplier_delivery_id: supplierDeliveryId,
        });
        if (item.isShowroom) results.showroom.push(item.itemName);
        else results.review.push({ item: item.itemName, reason: "no_so" });
        continue;
      }

      // Match against legacy orders
      const { data: orders } = await supabase.from("orders")
        .select("id, so_number, items, status")
        .eq("so_number", item.soNumber).in("status", ["Pending", "In Progress"]);

      if (!orders || orders.length === 0) {
        await supabase.from("do_review").insert({
          do_number: doData.doNumber || null, supplier: doData.supplier || null,
          do_date: doData.doDate || arrivalDate, so_number: item.soNumber,
          item_code: item.itemCode || null, item_name: item.itemName || null,
          quantity: item.quantity || null, reason: "so_not_found",
          status: "Pending", supplier_delivery_id: supplierDeliveryId,
        });
        results.review.push({ item: item.itemName, reason: "so_not_found" });
        continue;
      }

      let matched = false;
      // Extract meaningful keywords from DO item — expand abbreviations, skip noise
      const ABBREV = { pil: "pillow", mat: "mattress", tbl: "table", chr: "chair", cab: "cabinet", drs: "dresser", bfr: "bedframe", stl: "stool" };
      const SKIP = /^(mal|sg|pcs|unit|set|ctn|box|dun|cs\d*|qty|\+)$/;
      const doKeywords = (item.itemName || "").split(/[\s,\-\/]+/)
        .map(w => w.toLowerCase().trim()).filter(w => w.length > 2 && !/^\d+x?\d*c?m?$/.test(w) && !SKIP.test(w))
        .map(w => ABBREV[w] || w);
      for (const order of orders) {
        const oItems = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
        const updatedItems = oItems.map(oi => {
          const oiCode = (oi.itemCode || "").toLowerCase().trim();
          const oiName = (oi.itemName || "").toLowerCase();
          const doCode = (item.itemCode || "").toLowerCase().trim();
          // 1. Exact code match
          const codeMatch = doCode && oiCode && oiCode === doCode;
          // 2. Code contained in order item name or vice versa
          const codeInName = doCode && doCode.length >= 3 && (oiName.includes(doCode) || (oiCode && doCode.includes(oiCode)));
          // 3. Keyword match: at least 2 DO keywords found in order item name, or 1 keyword >= 5 chars
          const kwMatches = doKeywords.filter(kw => oiName.includes(kw) || oiCode.includes(kw));
          const keywordMatch = kwMatches.length >= 2 || kwMatches.some(kw => kw.length >= 5);
          if ((codeMatch || codeInName || keywordMatch) && !oi.arrivalDate) { matched = true; return { ...oi, arrivalDate }; }
          return oi;
        });
        if (matched) {
          await supabase.from("orders").update({ items: JSON.stringify(updatedItems) }).eq("id", order.id);
          results.updated.push({ item: item.itemName, so: item.soNumber });

          // Also try to mark PO items as received
          try {
            const { data: poItems } = await supabase.from("purchase_order_items")
              .select("id, po_id, quantity")
              .or(`product_code.eq.${item.itemCode},product_name.ilike.%${(item.itemName || "").substring(0, 10)}%`);
            for (const pi of (poItems || [])) {
              await supabase.from("purchase_order_items").update({ received_qty: pi.quantity, received_date: arrivalDate }).eq("id", pi.id);
              await updatePOStatus(pi.po_id);
            }
          } catch {}

          // Check if item exists in product master (fuzzy match)
          try {
            const cid = req.user.company_id;
            const code = (item.itemCode || "").toUpperCase().trim();
            const name = (item.itemName || "").trim();
            // Extract keywords from DO item name (skip short words, dimensions, abbreviations)
            const keywords = name.split(/[\s,\-\/]+/).filter(w => w.length > 2 && !/^\d+x?\d*c?m?$/i.test(w) && !/^(MAL|SG|PCS|UNIT|SET|CTN|BOX)$/i.test(w));
            let found = false;
            // 1. Exact code match
            if (code) {
              const { data: m1 } = await supabase.from("products").select("id").eq("company_id", cid).eq("code", code).limit(1);
              if (m1?.length) found = true;
            }
            // 2. Partial code match (code contained in product code or vice versa)
            if (!found && code.length >= 3) {
              const { data: m2 } = await supabase.from("products").select("id").eq("company_id", cid).ilike("code", `%${code}%`).limit(1);
              if (m2?.length) found = true;
            }
            // 3. Keyword search in product name (try longest keywords first)
            if (!found && keywords.length > 0) {
              const sorted = [...keywords].sort((a, b) => b.length - a.length);
              for (const kw of sorted.slice(0, 3)) {
                const { data: m3 } = await supabase.from("products").select("id").eq("company_id", cid).ilike("name", `%${kw}%`).limit(1);
                if (m3?.length) { found = true; break; }
              }
            }
            if (!found) {
              if (!results.unrecognized) results.unrecognized = [];
              results.unrecognized.push({ code: item.itemCode, name: item.itemName, so: item.soNumber });
            }
          } catch {}
          break;
        }
      }

      if (!matched) {
        await supabase.from("do_review").insert({
          do_number: doData.doNumber || null, supplier: doData.supplier || null,
          do_date: doData.doDate || arrivalDate, so_number: item.soNumber,
          item_code: item.itemCode || null, item_name: item.itemName || null,
          quantity: item.quantity || null, reason: "item_not_matched",
          status: "Pending", supplier_delivery_id: supplierDeliveryId,
        });
        results.review.push({ item: item.itemName, reason: "item_not_matched" });
      }
    }

    res.json({
      supplier: doData.supplier, do_number: doData.doNumber, do_date: doData.doDate || arrivalDate,
      photo_url: doPhotoUrl, total_items: doData.items.length,
      matched: results.updated.length, pending_review: results.review.length,
      showroom: results.showroom.length, unrecognized: (results.unrecognized || []).length,
      results,
    });
  } catch (err) { console.error("do-upload error:", err); res.status(500).json({ error: err.message }); }
});

// ── Sales Order Routes ────────────────────────────────────────────
// requireAuth: verify Bearer token, attach profile (no specific role required)
const requireAuth = async (req, res, next) => {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const { data: { user: authUser }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authUser) {
      console.error("requireAuth invalid token:", authErr?.message);
      return res.status(401).json({ error: "Invalid token", reason: authErr?.message || "no user" });
    }
    const { data: profile, error: profErr } = await supabase
      .from("users")
      .select("id, role, company_id, branch_id, name, salesman_name, is_active")
      .eq("id", authUser.id)
      .single();
    if (profErr) {
      console.error("requireAuth profile error:", profErr.message);
      return res.status(500).json({ error: "Profile lookup failed: " + profErr.message });
    }
    if (!profile || !profile.is_active) return res.status(403).json({ error: "Account inactive" });
    req.user = profile;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const ORDER_ROLES = ["master", "manager", "company_admin", "salesman"];

// Generate a readable order number: SO + YYMMDD + 4-digit sequence for the day
async function nextOrderNumber(company_id) {
  const now = new Date();
  const ymd = now.toISOString().slice(2, 10).replace(/-/g, "");
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const { count } = await supabase
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("company_id", company_id)
    .gte("created_at", dayStart);
  const seq = String((count || 0) + 1).padStart(3, "0");
  return `SO${ymd}-${seq}`;
}

// Map sales-order status → delivery (orders table) status
function deliveryStatusFromSO(s) {
  if (s === "delivered") return "Delivered";
  if (s === "cancelled") return "Cancelled";
  return "Pending";
}

// Mirror a sales order into the legacy `orders` table so the dashboard,
// calendar, and delivery routes pick it up. Keyed by so_number + company_id.
async function syncSalesOrderToDelivery(order, items) {
  try {
    const deliveryItems = (items || []).map(it => ({
      itemCode: it.product_code || "",
      itemName: [it.product_name, it.size, it.color, it.custom_dimensions].filter(Boolean).join(" "),
      unit: String(it.quantity || 1),
      supplier: it.supplier_name || "",
      itemOrderDate: "", supplierSentDate: "", arrivalDate: "",
    }));
    const row = {
      company_id: order.company_id,
      so_number: order.order_number,
      customer_name: order.customer_name,
      address: order.customer_address || null,
      contact: order.customer_contact || null,
      order_date: (order.created_at || new Date().toISOString()).slice(0, 10),
      salesman: order.salesman_name || null,
      order_amount: (Number(order.subtotal) || 0) - (Number(order.discount) || 0),
      balance: (Number(order.subtotal) || 0) - (Number(order.discount) || 0) - (Number(order.deposit) || 0),
      delivery_date: order.delivery_date || null,
      time_slot: order.delivery_time_slot || null,
      type: order.delivery_type || "Delivery",
      remark: order.remark || null,
      status: deliveryStatusFromSO(order.status),
      items: JSON.stringify(deliveryItems),
    };
    const { data: existing } = await supabase.from("orders")
      .select("id").eq("company_id", order.company_id).eq("so_number", order.order_number).maybeSingle();
    if (existing) await supabase.from("orders").update(row).eq("id", existing.id);
    else await supabase.from("orders").insert(row);
  } catch (e) {
    console.error("syncSalesOrderToDelivery error:", e.message);
  }
}

// GET /sales-orders — list; salesmen see only their own
app.get("/sales-orders", requireAuth, async (req, res) => {
  try {
    const { company_id, role, salesman_name } = req.user;
    const { status, search } = req.query;
    let query = supabase
      .from("sales_orders")
      .select("*, sales_order_items(*)")
      .eq("company_id", company_id)
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    if (search) query = query.or(`order_number.ilike.%${search}%,customer_name.ilike.%${search}%`);
    let { data, error } = await query;
    if (error) throw error;
    if (role === "salesman" && salesman_name) {
      const name = salesman_name.toLowerCase().trim();
      data = (data || []).filter(o => (o.salesman_name || "").toLowerCase().trim() === name);
    }
    res.json({ orders: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /sales-orders/:id
app.get("/sales-orders/:id", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("sales_orders")
      .select("*, sales_order_items(*)")
      .eq("id", req.params.id).eq("company_id", req.user.company_id).single();
    if (error || !data) return res.status(404).json({ error: "Order not found" });
    res.json({ order: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /sales-orders — create order with line items
app.post("/sales-orders", requireAuth, async (req, res) => {
  try {
    if (!ORDER_ROLES.includes(req.user.role)) return res.status(403).json({ error: "Insufficient permissions" });
    const { company_id, id: created_by, salesman_name, name } = req.user;
    const { customer_name, customer_contact, customer_address, status, notes, items,
            delivery_date, delivery_time_slot, delivery_type, remark, discount, deposit, payment_method,
            branch_id, salesman_names, country, gst_rate, gst_amount, gst_waived } = req.body;
    if (!customer_name) return res.status(400).json({ error: "customer_name is required" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "At least one item is required" });

    const subtotal = items.reduce((sum, it) => sum + (Number(it.unit_price) || 0) * (Number(it.quantity) || 1), 0);
    const order_number = await nextOrderNumber(company_id);
    const resolvedSalesman = salesman_names || salesman_name || name || null;

    const { data: order, error: orderErr } = await supabase
      .from("sales_orders")
      .insert({
        company_id, order_number, customer_name,
        customer_contact: customer_contact || null, customer_address: customer_address || null,
        salesman_name: resolvedSalesman, status: status || "draft",
        branch_id: branch_id || null,
        delivery_date: delivery_date || null, delivery_time_slot: delivery_time_slot || null,
        delivery_type: delivery_type || "Delivery", remark: remark || null,
        discount: Number(discount) || 0, deposit: Number(deposit) || 0, payment_method: payment_method || null,
        country: country || null, gst_rate: gst_rate != null ? Number(gst_rate) : null, gst_amount: gst_amount != null ? Number(gst_amount) : null, gst_waived: gst_waived || false,
        subtotal, notes: notes || null, created_by,
      })
      .select().single();
    if (orderErr) throw orderErr;

    const itemRows = items.map(it => ({
      order_id: order.id,
      product_id: it.product_id || null,
      product_code: it.product_code || null,
      product_name: it.product_name || null,
      size: it.size || null,
      color: it.color || null,
      is_custom: it.is_custom === true,
      custom_dimensions: it.custom_dimensions || null,
      quantity: Number(it.quantity) || 1,
      unit_price: it.unit_price ?? null,
      unit_cost: it.unit_cost ?? null,
      line_total: (Number(it.unit_price) || 0) * (Number(it.quantity) || 1),
      attachment_url: it.attachment_url || null,
      notes: it.notes || null,
    }));
    const { error: itemsErr } = await supabase.from("sales_order_items").insert(itemRows);
    if (itemsErr) throw itemsErr;

    const { data: full } = await supabase.from("sales_orders").select("*, sales_order_items(*)").eq("id", order.id).single();
    await syncSalesOrderToDelivery(full, full.sales_order_items);
    res.status(201).json({ order: full });
  } catch (err) { console.error("POST /sales-orders error:", err); res.status(500).json({ error: err.message }); }
});

// PUT /sales-orders/:id — update order + replace items
app.put("/sales-orders/:id", requireAuth, async (req, res) => {
  try {
    if (!ORDER_ROLES.includes(req.user.role)) return res.status(403).json({ error: "Insufficient permissions" });
    const { company_id } = req.user;
    const { id } = req.params;
    const { customer_name, customer_contact, customer_address, status, notes, items,
            delivery_date, delivery_time_slot, delivery_type, remark, discount, deposit, payment_method,
            branch_id, salesman_names, country, gst_rate, gst_amount, gst_waived } = req.body;

    const { data: existing } = await supabase.from("sales_orders").select("id").eq("id", id).eq("company_id", company_id).single();
    if (!existing) return res.status(404).json({ error: "Order not found" });

    const subtotal = (items || []).reduce((sum, it) => sum + (Number(it.unit_price) || 0) * (Number(it.quantity) || 1), 0);
    const { error: updErr } = await supabase.from("sales_orders").update({
      customer_name, customer_contact: customer_contact || null, customer_address: customer_address || null,
      salesman_name: salesman_names || null, status, notes: notes || null, subtotal,
      branch_id: branch_id || null,
      delivery_date: delivery_date || null, delivery_time_slot: delivery_time_slot || null,
      delivery_type: delivery_type || "Delivery", remark: remark || null,
      discount: Number(discount) || 0, deposit: Number(deposit) || 0, payment_method: payment_method || null,
      country: country || null, gst_rate: gst_rate != null ? Number(gst_rate) : null, gst_amount: gst_amount != null ? Number(gst_amount) : null,
    }).eq("id", id).eq("company_id", company_id);
    if (updErr) throw updErr;

    if (Array.isArray(items)) {
      await supabase.from("sales_order_items").delete().eq("order_id", id);
      const itemRows = items.map(it => ({
        order_id: id, product_id: it.product_id || null, product_code: it.product_code || null,
        product_name: it.product_name || null, size: it.size || null, color: it.color || null,
        is_custom: it.is_custom === true, custom_dimensions: it.custom_dimensions || null,
        quantity: Number(it.quantity) || 1, unit_price: it.unit_price ?? null, unit_cost: it.unit_cost ?? null,
        line_total: (Number(it.unit_price) || 0) * (Number(it.quantity) || 1),
        attachment_url: it.attachment_url || null, notes: it.notes || null,
      }));
      const { error: itemsErr } = await supabase.from("sales_order_items").insert(itemRows);
      if (itemsErr) throw itemsErr;
    }

    const { data: full } = await supabase.from("sales_orders").select("*, sales_order_items(*)").eq("id", id).single();
    await syncSalesOrderToDelivery(full, full.sales_order_items);
    res.json({ order: full });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /sales-orders/:id/status
app.patch("/sales-orders/:id/status", requireAuth, async (req, res) => {
  try {
    if (!ORDER_ROLES.includes(req.user.role)) return res.status(403).json({ error: "Insufficient permissions" });
    const { status } = req.body;
    const { data, error } = await supabase.from("sales_orders")
      .update({ status }).eq("id", req.params.id).eq("company_id", req.user.company_id)
      .select("*, sales_order_items(*)").single();
    if (error) throw error;
    await syncSalesOrderToDelivery(data, data.sales_order_items);
    res.json({ order: { id: data.id, status: data.status } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /sales-orders/:id
app.delete("/sales-orders/:id", requireAuth, async (req, res) => {
  try {
    if (!["master", "manager", "company_admin"].includes(req.user.role)) return res.status(403).json({ error: "Insufficient permissions" });
    const company_id = req.user.company_id;
    const { data: existing } = await supabase.from("sales_orders").select("order_number").eq("id", req.params.id).eq("company_id", company_id).single();
    const { error } = await supabase.from("sales_orders").delete().eq("id", req.params.id).eq("company_id", company_id);
    if (error) throw error;
    if (existing?.order_number) {
      await supabase.from("orders").delete().eq("company_id", company_id).eq("so_number", existing.order_number);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /sales-orders/upload-attachment — upload a drawing/site measurement, returns URL
app.post("/sales-orders/upload-attachment", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    const ext = file.originalname.split(".").pop();
    const path = `order-attachments/${req.user.company_id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await supabase.storage.from("order-attachments").upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
    if (upErr) return res.status(500).json({ error: "Upload failed: " + upErr.message });
    const { data } = supabase.storage.from("order-attachments").getPublicUrl(path);
    res.json({ url: data?.publicUrl || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /sales-orders/:id/signature — save customer signature data URL
app.patch("/sales-orders/:id/signature", requireAuth, async (req, res) => {
  try {
    const { signature } = req.body;
    const { data, error } = await supabase.from("sales_orders")
      .update({ customer_signature: signature || null })
      .eq("id", req.params.id).eq("company_id", req.user.company_id)
      .select("id, customer_signature").single();
    if (error) throw error;
    res.json({ ok: true, signature: data.customer_signature });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Purchase Order Routes ─────────────────────────────────────────

async function nextPONumber(company_id) {
  const now = new Date();
  const ymd = now.toISOString().slice(2, 10).replace(/-/g, "");
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const { count } = await supabase
    .from("purchase_orders")
    .select("id", { count: "exact", head: true })
    .eq("company_id", company_id)
    .gte("created_at", dayStart);
  return `PO${ymd}-${String((count || 0) + 1).padStart(3, "0")}`;
}

async function updatePOStatus(poId) {
  const { data: items } = await supabase.from("purchase_order_items").select("quantity, received_qty").eq("po_id", poId);
  if (!items || items.length === 0) return;
  const allReceived = items.every(i => (i.received_qty || 0) >= (i.quantity || 1));
  const someReceived = items.some(i => (i.received_qty || 0) > 0);
  const status = allReceived ? "received" : someReceived ? "partial" : null;
  if (status) await supabase.from("purchase_orders").update({ status, updated_at: new Date().toISOString() }).eq("id", poId);
}

// POST /sales-orders/:id/submit-po — generate POs from a sales order
app.post("/sales-orders/:id/submit-po", requireAuth, async (req, res) => {
  try {
    if (!ORDER_ROLES.includes(req.user.role)) return res.status(403).json({ error: "Insufficient permissions" });
    const { company_id } = req.user;
    const { item_ids } = req.body;

    const { data: order } = await supabase.from("sales_orders")
      .select("*, sales_order_items(*)").eq("id", req.params.id).eq("company_id", company_id).single();
    if (!order) return res.status(404).json({ error: "Order not found" });

    let items = order.sales_order_items || [];
    if (Array.isArray(item_ids) && item_ids.length > 0) {
      items = items.filter(i => item_ids.includes(i.id));
    }

    const productIds = items.map(i => i.product_id).filter(Boolean);
    const { data: products } = await supabase.from("products")
      .select("id, supplier_id, suppliers(id, name)").in("id", productIds.length ? productIds : ["_"]);
    const prodMap = new Map((products || []).map(p => [p.id, p]));

    const grouped = {};
    const noSupplier = [];
    for (const item of items) {
      const prod = prodMap.get(item.product_id);
      const supplierId = prod?.supplier_id;
      if (!supplierId) { noSupplier.push(item); continue; }
      if (!grouped[supplierId]) grouped[supplierId] = { supplier_id: supplierId, supplier_name: prod.suppliers?.name || "", items: [] };
      grouped[supplierId].items.push(item);
    }

    const createdPOs = [];
    for (const group of Object.values(grouped)) {
      const po_number = await nextPONumber(company_id);
      const { data: po, error: poErr } = await supabase.from("purchase_orders")
        .insert({ company_id, po_number, supplier_id: group.supplier_id, sales_order_id: order.id, status: "draft", created_by: req.user.id })
        .select().single();
      if (poErr) throw poErr;

      const poItems = group.items.map(it => ({
        po_id: po.id, sales_order_item_id: it.id,
        product_id: it.product_id, product_code: it.product_code, product_name: it.product_name,
        size: it.size, color: it.color,
        custom_dimensions: it.custom_dimensions || null,
        attachment_url: it.attachment_url || null,
        quantity: Number(it.quantity) || 1, unit_cost: it.unit_cost ?? null,
        line_total: (Number(it.unit_cost) || 0) * (Number(it.quantity) || 1),
        notes: it.notes || null,
      }));
      const { error: itemsErr } = await supabase.from("purchase_order_items").insert(poItems);
      if (itemsErr) { console.error("PO items insert error:", itemsErr); throw itemsErr; }
      createdPOs.push({ ...po, supplier_name: group.supplier_name, item_count: group.items.length });
    }

    res.json({ created: createdPOs, skipped_no_supplier: noSupplier.length });
  } catch (err) { console.error("submit-po error:", err); res.status(500).json({ error: err.message }); }
});

// GET /purchase-orders
app.get("/purchase-orders", requireAuth, async (req, res) => {
  try {
    const { company_id } = req.user;
    const { status, supplier_id, search } = req.query;
    let query = supabase.from("purchase_orders")
      .select("*, purchase_order_items(*), suppliers(id, name)")
      .eq("company_id", company_id)
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    if (supplier_id) query = query.eq("supplier_id", supplier_id);
    if (search) query = query.or(`po_number.ilike.%${search}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ orders: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /purchase-orders/:id
app.get("/purchase-orders/:id", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("purchase_orders")
      .select("*, purchase_order_items(*), suppliers(id, name)")
      .eq("id", req.params.id).eq("company_id", req.user.company_id).single();
    if (error || !data) return res.status(404).json({ error: "PO not found" });
    res.json({ order: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /purchase-orders/:id
app.put("/purchase-orders/:id", requireAuth, async (req, res) => {
  try {
    const { expected_date, notes } = req.body;
    const { data, error } = await supabase.from("purchase_orders")
      .update({ expected_date: expected_date || null, notes: notes || null, updated_at: new Date().toISOString() })
      .eq("id", req.params.id).eq("company_id", req.user.company_id).select().single();
    if (error) throw error;
    res.json({ order: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /purchase-orders/:id/status
app.patch("/purchase-orders/:id/status", requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabase.from("purchase_orders")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", req.params.id).eq("company_id", req.user.company_id)
      .select("id, status").single();
    if (error) throw error;
    res.json({ order: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /purchase-orders/:id — draft only
app.delete("/purchase-orders/:id", requireAuth, async (req, res) => {
  try {
    const { data: po } = await supabase.from("purchase_orders").select("status").eq("id", req.params.id).eq("company_id", req.user.company_id).single();
    if (!po) return res.status(404).json({ error: "PO not found" });
    if (po.status !== "draft") return res.status(400).json({ error: "Only draft POs can be deleted" });
    await supabase.from("purchase_order_items").delete().eq("po_id", req.params.id);
    await supabase.from("purchase_orders").delete().eq("id", req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /purchase-order-items/:id/receive
app.patch("/purchase-order-items/:id/receive", requireAuth, async (req, res) => {
  try {
    const { received_qty, received_date, warehouse_id } = req.body;
    const rcvDate = received_date || new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase.from("purchase_order_items")
      .update({ received_qty: Number(received_qty) || 0, received_date: rcvDate })
      .eq("id", req.params.id).select("id, po_id, product_id, received_qty, quantity").single();
    if (error) throw error;
    await updatePOStatus(data.po_id);

    // Record lead time
    try {
      const { data: po } = await supabase.from("purchase_orders").select("supplier_id, created_at, company_id").eq("id", data.po_id).single();
      if (po) await recordLeadTime(po.company_id, po.supplier_id, data.product_id, po.created_at, rcvDate);
    } catch {}

    // Stock in if warehouse specified
    if (warehouse_id && data.product_id) {
      try {
        await adjustStock(req.user.company_id, warehouse_id, data.product_id, Number(received_qty) || data.quantity, "in", "do", data.po_id, `PO receive`, req.user.id);
      } catch {}
    }

    res.json({ item: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Health Check ──────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", message: "V Haus Telegram Bot Server" }));

// ── Global error handler ─────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
});

// ── Start Server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));