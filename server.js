require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

const app = express();
app.use(express.json());

// ── Clients ──────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── Helpers ───────────────────────────────────────────────────────
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

// ── OpenAI Vision ─────────────────────────────────────────────────
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
- deliveryDate: look for "DELIVERY DATE:". Convert to YYYY-MM-DD format. If it says "ASAP" or is unclear, return the string "ASAP". Leave empty string only if delivery date field is completely blank.
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
          {
            type: "input_text",
            text: prompt,
          },
          {
            type: "input_image",
            image_url: `data:image/jpeg;base64,${base64Image}`,
          },
        ],
      },
    ],
  });

  const raw = response.output_text.trim();
  // Strip markdown fences if present
  const clean = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(clean);
};

// ── Parse Delivery Date from natural text ────────────────────────
const parseDeliveryDate = (text) => {
  const today = new Date();

  // Check for explicit date pattern like 2/6, 2/6/2026, 02-06-2026
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

  // Check for relative keywords
  const lower = text.toLowerCase();
  if (lower.includes("tmr") || lower.includes("tomorrow") || lower.includes("esok")) {
    const tmr = new Date(today);
    tmr.setDate(today.getDate() + 1);
    return tmr.toISOString().split("T")[0];
  }
  if (lower.includes("today") || lower.includes("hari ini")) {
    return today.toISOString().split("T")[0];
  }
  if (lower.includes("next week") || lower.includes("minggu depan")) {
    const nw = new Date(today);
    nw.setDate(today.getDate() + 7);
    return nw.toISOString().split("T")[0];
  }

  return null;
};

// ── Parse SO Update Message ───────────────────────────────────────
const parseUpdateMessage = (text) => {
  // Match SO number
  const soMatch = text.match(/SO\s*[:\-]?\s*(\S+)/i);
  // Match delivery date line
  const dateMatch = text.match(/DELIVERY\s*DATE\s*[:\-]?\s*(.+)/i);

  if (!soMatch || !dateMatch) return null;

  const soNumber = soMatch[1].trim();
  const dateText = dateMatch[1].trim();
  const deliveryDate = parseDeliveryDate(dateText);

  // Extract remark — everything after the delivery date line
  const lines = text.split("\n");
  const dateLineIdx = lines.findIndex(l => /DELIVERY\s*DATE/i.test(l));
  const remark = lines.slice(dateLineIdx + 1).join(" ").trim();

  return { soNumber, deliveryDate, dateText, remark };
};
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200); // Always acknowledge Telegram immediately

  try {
    const message = req.body.message;
    if (!message) return;

    const chatId = message.chat.id;

    // ── Handle text messages for delivery date update ──────────────
    if (message.text) {
      const parsed = parseUpdateMessage(message.text);
      if (message.text && message.text.startsWith("/schedule")) {
  await handleScheduleCommand(chatId, message.text);
  return;
}
      if (!parsed) return; // Not a delivery update message, ignore

      const { soNumber, deliveryDate, dateText, remark } = parsed;

      // Find the SO in Supabase
      const { data: existing, error: findErr } = await supabase
        .from("orders")
        .select("id, so_number, customer_name, delivery_date, remark")
        .eq("so_number", soNumber)
        .maybeSingle();

      if (findErr) {
        await sendMessage(chatId, `❌ Database error: ${findErr.message}`);
        return;
      }

      if (!existing) {
        await sendMessage(chatId, `❌ SO *${soNumber}* not found in the system.`);
        return;
      }

      if (!deliveryDate) {
        await sendMessage(chatId, `⚠️ Could not understand delivery date: *"${dateText}"*\nPlease use format like: \`2/6\` or \`tmr\` or \`3/6/2026\``);
        return;
      }

      // Build updated remark — append new remark if any
      const updatedRemark = remark
        ? `${existing.remark ? existing.remark + " | " : ""}${remark}`
        : existing.remark;

      // Update delivery date in Supabase
      const { error: updateErr } = await supabase
        .from("orders")
        .update({
          delivery_date: deliveryDate,
          ...(updatedRemark && { remark: updatedRemark })
        })
        .eq("so_number", soNumber);

      if (updateErr) {
        await sendMessage(chatId, `❌ Failed to update SO *${soNumber}*\nError: ${updateErr.message}`);
        return;
      }

      const formattedDate = new Date(deliveryDate).toLocaleDateString("en-MY", {
        weekday: "long", year: "numeric", month: "long", day: "numeric"
      });

      await sendMessage(chatId,
        `✅ *Delivery Date Updated*\n\n` +
        `📋 *SO:* ${soNumber}\n` +
        `👤 *Customer:* ${existing.customer_name || "-"}\n` +
        `📅 *New Delivery Date:* ${formattedDate}\n` +
        `📝 *Date Input:* "${dateText}"\n` +
        `${remark ? `💬 *Remark:* ${remark}\n` : ""}` +
        `\n_Delivery sheet has been updated._`
      );
      return;
    }

    // ── Handle photo messages for new sales order ──────────────────
    // Ignore non-photo messages
    if (!message.photo || message.photo.length === 0) return;

    await sendMessage(chatId, "📷 Processing sales order image...");

    // Get largest photo
    const photo = message.photo[message.photo.length - 1];
    const fileUrl = await getFileUrl(photo.file_id);
    const base64Image = await downloadImageAsBase64(fileUrl);

    await sendMessage(chatId, "🔍 Extracting order details with AI...");

    // Extract order data using OpenAI Vision
    let data;
    try {
      data = await extractOrderFromImage(base64Image);
    } catch (err) {
      await sendMessage(chatId, `❌ Failed to extract order data.\nError: ${err.message}`);
      return;
    }

    // Handle ASAP delivery date — schedule 3 weeks from today
    if (!data.deliveryDate || data.deliveryDate.toUpperCase() === "ASAP") {
      const asapDate = new Date();
      asapDate.setDate(asapDate.getDate() + 21);
      data.deliveryDate = asapDate.toISOString().split("T")[0];
      data._asapScheduled = true;
    }

    // Validate required fields
    if (!data.soNumber) {
      await sendMessage(chatId, "❌ Could not find SO Number in the image. Please try again with a clearer image.");
      return;
    }

    if (!data.deliveryDate) {
      await sendMessage(chatId, `⚠️ SO *${data.soNumber}* extracted but no delivery date found.\nPlease add the delivery date manually in the system.`);
    }

    // Check for duplicate SO number
    const { data: existing, error: checkErr } = await supabase
      .from("orders")
      .select("id")
      .eq("so_number", data.soNumber)
      .maybeSingle();

    if (checkErr) {
      await sendMessage(chatId, `❌ Database error: ${checkErr.message}`);
      return;
    }

    if (existing) {
      await sendMessage(chatId, `⚠️ SO *${data.soNumber}* already exists in the system. Skipping insert.`);
      return;
    }

    // Insert into Supabase
    const payload = {
      so_number: data.soNumber,
      customer_name: data.customerName,
      address: data.address,
      contact: data.contact,
      order_date: data.orderDate || null,
      salesman: data.salesman,
      order_amount: data.orderAmount,
      balance: data.balance,
      delivery_date: data.deliveryDate || null,
      time_slot: data.timeSlot,
      plate_no: data.plateNo,
      type: data.type || "Delivery",
      service_note: data.serviceNote,
      remark: data.remark,
      status: "Pending",
      items: JSON.stringify(data.items || []),
    };

    const { error: insertErr } = await supabase.from("orders").insert(payload);

    if (insertErr) {
      await sendMessage(chatId, `❌ Failed to save order.\nError: ${insertErr.message}`);
      return;
    }

    // Build items summary
    const itemsSummary = (data.items || [])
      .map((item, i) => `  ${i + 1}. ${item.itemName || "Unknown item"} x${item.unit || 1}${item.supplier ? ` (${item.supplier})` : ""}`)
      .join("\n");

    // Success reply
    const asapNote = data._asapScheduled ? `\n⚠️ _Delivery date was ASAP — auto scheduled 3 weeks from today_` : "";
    const reply = `✅ *Order Added Successfully*

📋 *SO:* ${data.soNumber}
👤 *Customer:* ${data.customerName || "-"}
📅 *Delivery Date:* ${data.deliveryDate || "-"}${asapNote}
⏰ *Time Slot:* ${data.timeSlot || "-"}
👨‍💼 *Salesman:* ${data.salesman || "-"}
💰 *Amount:* RM ${data.orderAmount || "0"}
🔴 *Balance:* RM ${data.balance || "0"}
📦 *Type:* ${data.type || "Delivery"}

*Items:*
${itemsSummary || "  No items extracted"}

_Order has been saved to the delivery sheet._`;

    await sendMessage(chatId, reply);
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

// ── Health Check ──────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", message: "V Haus Telegram Bot Server" }));


// ── Delivery Schedule API ─────────────────────────────────────────
// Add CORS so React frontend can call this backend
const cors = require("cors");
app.use(cors());

// GET /delivery/routes?date=2026-07-15
// Returns all routes + their assigned orders for a date
app.get("/delivery/routes", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });

  const { data: routes, error: routeErr } = await supabase
    .from("delivery_routes")
    .select("*")
    .eq("delivery_date", date)
    .order("created_at");

  if (routeErr) return res.status(500).json({ error: routeErr.message });

  // For each route, get assigned orders
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
// Returns orders for a date that are not yet assigned to any route
app.get("/delivery/unassigned", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });

  // Get all orders for that date
  const { data: orders, error: ordErr } = await supabase
    .from("orders")
    .select("*")
    .eq("delivery_date", date);

  if (ordErr) return res.status(500).json({ error: ordErr.message });

  // Get assigned order IDs for that date
  const { data: assigned } = await supabase
    .from("delivery_route_orders")
    .select("order_id, delivery_routes!inner(delivery_date)")
    .eq("delivery_routes.delivery_date", date);

  const assignedIds = new Set((assigned || []).map(a => a.order_id));
  const unassigned = (orders || []).filter(o => !assignedIds.has(o.id));

  res.json(unassigned);
});

// POST /delivery/routes
// Create a new route
app.post("/delivery/routes", async (req, res) => {
  const { delivery_date, lorry_plate, driver_name, area, notes } = req.body;
  if (!delivery_date) return res.status(400).json({ error: "delivery_date is required" });

  const { data, error } = await supabase
    .from("delivery_routes")
    .insert({ delivery_date, lorry_plate, driver_name, area, notes, status: "Pending" })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /delivery/routes/:id
// Update route details (lorry, driver, area, status)
app.patch("/delivery/routes/:id", async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  const { data, error } = await supabase
    .from("delivery_routes")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /delivery/routes/:id
// Delete a route (cascade deletes route_orders)
app.delete("/delivery/routes/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("delivery_routes").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST /delivery/routes/:routeId/orders
// Assign an order to a route
app.post("/delivery/routes/:routeId/orders", async (req, res) => {
  const { routeId } = req.params;
  const { order_id, sequence_no } = req.body;

  const { data, error } = await supabase
    .from("delivery_route_orders")
    .insert({ route_id: routeId, order_id, sequence_no: sequence_no || 1 })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /delivery/routes/:routeId/orders/:orderId
// Update sequence number
app.patch("/delivery/routes/:routeId/orders/:orderId", async (req, res) => {
  const { routeId, orderId } = req.params;
  const { sequence_no } = req.body;

  const { data, error } = await supabase
    .from("delivery_route_orders")
    .update({ sequence_no })
    .eq("route_id", routeId)
    .eq("order_id", orderId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /delivery/routes/:routeId/orders/:orderId
// Unassign order from route
app.delete("/delivery/routes/:routeId/orders/:orderId", async (req, res) => {
  const { routeId, orderId } = req.params;
  const { error } = await supabase
    .from("delivery_route_orders")
    .delete()
    .eq("route_id", routeId)
    .eq("order_id", orderId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Bot: /schedule command ────────────────────────────────────────
const handleScheduleCommand = async (chatId, text) => {
  // Parse date from /schedule 15/7 or /schedule 2026-07-15
  const dateMatch = text.match(/\/schedule\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i);
  if (!dateMatch) {
    await sendMessage(chatId, "Usage: `/schedule 15/7` or `/schedule 2026-07-15`");
    return;
  }

  const day = parseInt(dateMatch[1]);
  const month = parseInt(dateMatch[2]) - 1;
  const year = dateMatch[3]
    ? (dateMatch[3].length === 2 ? 2000 + parseInt(dateMatch[3]) : parseInt(dateMatch[3]))
    : new Date().getFullYear();
  const dateObj = new Date(year, month, day);
  const dateStr = dateObj.toISOString().split("T")[0];
  const dateLabel = dateObj.toLocaleDateString("en-MY", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // Get orders for that date
  const { data: orders, error } = await supabase
    .from("orders")
    .select("*")
    .eq("delivery_date", dateStr);

  if (error) { await sendMessage(chatId, `❌ Error: ${error.message}`); return; }
  if (!orders || orders.length === 0) {
    await sendMessage(chatId, `📅 No orders found for *${dateLabel}*`);
    return;
  }

  // Group by area (from address)
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

  // Build reply
  let reply = `📦 *Delivery Schedule — ${dateLabel}*\n`;
  reply += `Total: *${orders.length} orders*\n\n`;
  reply += `*Suggested grouping by area:*\n`;
  reply += `━━━━━━━━━━━━━━━━━━━━\n`;

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

  reply += `\n━━━━━━━━━━━━━━━━━━━━\n`;
  reply += `_Open delivery sheet to assign lorries._`;

  await sendMessage(chatId, reply);
};

// ── Delivery Schedule API ─────────────────────────────────────────
// Add CORS so React frontend can call this backend
const cors = require("cors");
app.use(cors());

// GET /delivery/routes?date=2026-07-15
// Returns all routes + their assigned orders for a date
app.get("/delivery/routes", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });

  const { data: routes, error: routeErr } = await supabase
    .from("delivery_routes")
    .select("*")
    .eq("delivery_date", date)
    .order("created_at");

  if (routeErr) return res.status(500).json({ error: routeErr.message });

  // For each route, get assigned orders
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
// Returns orders for a date that are not yet assigned to any route
app.get("/delivery/unassigned", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });

  // Get all orders for that date
  const { data: orders, error: ordErr } = await supabase
    .from("orders")
    .select("*")
    .eq("delivery_date", date);

  if (ordErr) return res.status(500).json({ error: ordErr.message });

  // Get assigned order IDs for that date
  const { data: assigned } = await supabase
    .from("delivery_route_orders")
    .select("order_id, delivery_routes!inner(delivery_date)")
    .eq("delivery_routes.delivery_date", date);

  const assignedIds = new Set((assigned || []).map(a => a.order_id));
  const unassigned = (orders || []).filter(o => !assignedIds.has(o.id));

  res.json(unassigned);
});

// POST /delivery/routes
// Create a new route
app.post("/delivery/routes", async (req, res) => {
  const { delivery_date, lorry_plate, driver_name, area, notes } = req.body;
  if (!delivery_date) return res.status(400).json({ error: "delivery_date is required" });

  const { data, error } = await supabase
    .from("delivery_routes")
    .insert({ delivery_date, lorry_plate, driver_name, area, notes, status: "Pending" })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /delivery/routes/:id
// Update route details (lorry, driver, area, status)
app.patch("/delivery/routes/:id", async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  const { data, error } = await supabase
    .from("delivery_routes")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /delivery/routes/:id
// Delete a route (cascade deletes route_orders)
app.delete("/delivery/routes/:id", async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("delivery_routes").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST /delivery/routes/:routeId/orders
// Assign an order to a route
app.post("/delivery/routes/:routeId/orders", async (req, res) => {
  const { routeId } = req.params;
  const { order_id, sequence_no } = req.body;

  const { data, error } = await supabase
    .from("delivery_route_orders")
    .insert({ route_id: routeId, order_id, sequence_no: sequence_no || 1 })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /delivery/routes/:routeId/orders/:orderId
// Update sequence number
app.patch("/delivery/routes/:routeId/orders/:orderId", async (req, res) => {
  const { routeId, orderId } = req.params;
  const { sequence_no } = req.body;

  const { data, error } = await supabase
    .from("delivery_route_orders")
    .update({ sequence_no })
    .eq("route_id", routeId)
    .eq("order_id", orderId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /delivery/routes/:routeId/orders/:orderId
// Unassign order from route
app.delete("/delivery/routes/:routeId/orders/:orderId", async (req, res) => {
  const { routeId, orderId } = req.params;
  const { error } = await supabase
    .from("delivery_route_orders")
    .delete()
    .eq("route_id", routeId)
    .eq("order_id", orderId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Bot: /schedule command ────────────────────────────────────────
const handleScheduleCommand = async (chatId, text) => {
  // Parse date from /schedule 15/7 or /schedule 2026-07-15
  const dateMatch = text.match(/\/schedule\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i);
  if (!dateMatch) {
    await sendMessage(chatId, "Usage: `/schedule 15/7` or `/schedule 2026-07-15`");
    return;
  }

  const day = parseInt(dateMatch[1]);
  const month = parseInt(dateMatch[2]) - 1;
  const year = dateMatch[3]
    ? (dateMatch[3].length === 2 ? 2000 + parseInt(dateMatch[3]) : parseInt(dateMatch[3]))
    : new Date().getFullYear();
  const dateObj = new Date(year, month, day);
  const dateStr = dateObj.toISOString().split("T")[0];
  const dateLabel = dateObj.toLocaleDateString("en-MY", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  // Get orders for that date
  const { data: orders, error } = await supabase
    .from("orders")
    .select("*")
    .eq("delivery_date", dateStr);

  if (error) { await sendMessage(chatId, `❌ Error: ${error.message}`); return; }
  if (!orders || orders.length === 0) {
    await sendMessage(chatId, `📅 No orders found for *${dateLabel}*`);
    return;
  }

  // Group by area (from address)
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

  // Build reply
  let reply = `📦 *Delivery Schedule — ${dateLabel}*\n`;
  reply += `Total: *${orders.length} orders*\n\n`;
  reply += `*Suggested grouping by area:*\n`;
  reply += `━━━━━━━━━━━━━━━━━━━━\n`;

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

  reply += `\n━━━━━━━━━━━━━━━━━━━━\n`;
  reply += `_Open delivery sheet to assign lorries._`;

  await sendMessage(chatId, reply);
};


// ── Start Server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
