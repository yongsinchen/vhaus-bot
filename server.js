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

// ── In-memory pending drafts ──────────────────────────────────────
// Key: `${chatId}:${userId}` — each salesman has their own draft
const pendingOrders = new Map();

// ── Telegram Helpers ──────────────────────────────────────────────
const sendMessage = async (chatId, text) => {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  });
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
  "deliveryDate": "YYYY-MM-DD or empty",
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

Rules:
- soNumber: look for "SALES ORDER:" or "SO:" number, usually a 5-digit number like 31073
- customerName: look for "NAME:" field
- address: look for "ADDRESS:" field. If it says "SAME WITH XXXXX" keep that text as-is
- contact: look for "H/P NO:" or "TEL:" or "CONTACT:" field. Leave empty if not found
- orderDate: look for "ORDER DATE:". Convert to YYYY-MM-DD. Example: 1/6/2026 = 2026-06-01. Leave empty if not found
- deliveryDate: look for "DELIVERY DATE:". Convert to YYYY-MM-DD format. If it says "ASAP" or is unclear, return the string "ASAP". Leave empty string only if delivery date field is completely blank
- salesman: look for "SALES ASSISTANT:" or "ORDER BY:" field
- orderAmount: look for "TOTAL" amount, numeric only, no RM symbol. Example: 5590
- balance: look for "BALANCE" amount, numeric only, no RM symbol. Example: 3891
- items: extract ALL item rows from the DESCRIPTION column. Each numbered row (1., 2., 3.) is a separate item. Sub-items with "-" under a main item should be combined into one item description
- For FOC items (free of charge), include them as separate items with unit price 0
- itemCode: the product code if shown (e.g. 5023). Leave empty if not shown
- itemName: full description of the item including sub-components
- unit: quantity from QTY column, default "1" if not shown
- remark: extract from "REMARKS:" section at the bottom
- type: always "Delivery" unless the order says "SERVICE"
- status: always "Pending"
- If a field cannot be found, use empty string`;

  const response = await openai.responses.create({
    model: "gpt-4o",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: `data:image/jpeg;base64,${base64Image}` },
        ],
      },
    ],
  });

  const raw = response.output_text.trim();
  const clean = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(clean);
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
    `Delivery Date: ${fmt(data.deliveryDate)}\n` +
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
- For delivery date: keep the user's natural language value as-is (e.g. "Aug - Sept", "October", "ASAP") — do NOT convert to ISO format unless user gives a specific date like "20/6/2026".
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
  if (!draft.soNumber) {
    return { ok: false, msg: "❌ SO Number is required before saving." };
  }

  // Resolve ASAP / natural language delivery date → use as-is in DB, just handle ASAP
  let deliveryDate = draft.deliveryDate;
  let asapScheduled = false;
  if (!deliveryDate || deliveryDate.toString().toUpperCase() === "ASAP") {
    const asapDate = new Date();
    asapDate.setDate(asapDate.getDate() + 21);
    deliveryDate = asapDate.toISOString().split("T")[0];
    asapScheduled = true;
  }

  // Duplicate SO check
  const { data: existing } = await supabase
    .from("orders").select("id").eq("so_number", draft.soNumber).maybeSingle();
  if (existing) return { ok: false, msg: `❌ SO *${draft.soNumber}* already exists in the system.` };

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
    remark: draft.remark || null,
    status: "Pending",
    items: JSON.stringify(draft.items || []),
  };

  const { error } = await supabase.from("orders").insert(payload);
  if (error) return { ok: false, msg: `❌ Insert failed: ${error.message}` };

  const asapNote = asapScheduled ? `\n⚠️ _Delivery date was ASAP — auto scheduled 3 weeks from today_` : "";
  return {
    ok: true,
    msg: `✅ *Order Saved Successfully*\n\n📋 *SO:* ${draft.soNumber}\n👤 *Customer:* ${draft.customerName || "-"}\n📅 *Delivery Date:* ${deliveryDate}${asapNote}\n\n_Order has been saved to the delivery sheet._`,
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
    } else {
      await sendMessage(chatId, result.msg + "\n\nDraft is still active. Make corrections and reply YES again.");
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

// ── Telegram Webhook ──────────────────────────────────────────────
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.message;
    if (!message) return;
    const chatId = message.chat.id;
    const userId = message.from?.id;
    const draftKey = `${chatId}:${userId}`;

    // ── Text messages ─────────────────────────────────────────────
    if (message.text) {
      // Pending draft exists — route ALL text to confirmation handler first
      if (pendingOrders.has(draftKey)) {
        await handlePendingDraftMessage(chatId, userId, message.text);
        return;
      }

      // No pending draft — existing flows unchanged
      if (message.text.startsWith("/schedule")) {
        await handleScheduleCommand(chatId, message.text);
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
    try { data = await extractOrderFromImage(base64Image); }
    catch (err) { await sendMessage(chatId, `❌ Failed to extract order data.\nError: ${err.message}`); return; }

    if (!data.soNumber) {
      await sendMessage(chatId, "❌ Could not find SO Number in the image. Please try again with a clearer image.");
      return;
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
