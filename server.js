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
  const prompt = `You are a sales order OCR assistant.
Extract all information from this handwritten or printed sales order image.
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
- soNumber: look for SO number, invoice number, order number
- orderDate and deliveryDate must be in YYYY-MM-DD format, or leave empty string
- orderAmount and balance must be numeric string only, no currency symbol
- items array must have at least one entry even if details are partial
- type must be either "Delivery" or "Service"
- status must always be "Pending"
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

// ── Webhook Handler ───────────────────────────────────────────────
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200); // Always acknowledge Telegram immediately

  try {
    const message = req.body.message;
    if (!message) return;

    const chatId = message.chat.id;

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
    const reply = `✅ *Order Added Successfully*

📋 *SO:* ${data.soNumber}
👤 *Customer:* ${data.customerName || "-"}
📅 *Delivery Date:* ${data.deliveryDate || "-"}
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

// ── Start Server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));