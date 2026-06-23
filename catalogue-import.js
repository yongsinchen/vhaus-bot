const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const OpenAI = require('openai');
const { supabase } = require('../lib/supabase');
const { requireRole } = require('../middleware/auth');

const MANAGE_ROLES = ['master', 'manager', 'company_admin'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── helpers ──────────────────────────────────────────────────────────────────

// Normalise a raw AI/xlsx row into { code, name, unit_cost, unit_price, description }
function normaliseRow(raw) {
  const find = (...keys) => {
    for (const k of keys) {
      const val = raw[k] ?? raw[k?.toLowerCase()] ?? raw[k?.toUpperCase()];
      if (val !== undefined && val !== null && val !== '') return String(val).trim();
    }
    return '';
  };
  const toNum = (v) => {
    const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
    return isNaN(n) ? null : n;
  };

  return {
    product_code: find('code', 'Code', 'item_code', 'Item Code', 'SKU', 'sku', 'Model', 'model').toUpperCase(),
    product_name: find('name', 'Name', 'item_name', 'Item Name', 'Product', 'product', 'Description', 'description'),
    unit_cost:    toNum(find('cost', 'Cost', 'unit_cost', 'Unit Cost', 'Buy Price', 'buy_price', 'purchase_price')),
    unit_price:   toNum(find('price', 'Price', 'unit_price', 'Unit Price', 'Sell Price', 'sell_price', 'selling_price')),
  };
}

// Parse XLSX buffer → array of normalised rows
function parseXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  return rows.map(normaliseRow).filter(r => r.product_code || r.product_name);
}

// Call GPT-4o vision on a PDF or image buffer
async function parseWithVision(buffer, mimeType) {
  const base64 = buffer.toString('base64');

  const isImage = mimeType.startsWith('image/');
  const contentParts = isImage
    ? [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'high' } },
        { type: 'text', text: VISION_PROMPT },
      ]
    : [
        // PDF: send as document
        { type: 'text', text: `${VISION_PROMPT}\n\nFile is a PDF encoded in base64:\n${base64.slice(0, 200000)}` },
      ];

  const resp = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 4000,
    messages: [{ role: 'user', content: contentParts }],
  });

  const text = resp.choices[0].message.content.trim();

  // Strip markdown fences if present
  const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new Error('AI did not return valid JSON. Raw: ' + text.slice(0, 300));
  }

  const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.products ?? [];
  return items.map(normaliseRow).filter(r => r.product_code || r.product_name);
}

const VISION_PROMPT = `You are a catalogue parser. Extract every product from this catalogue page / document.
Return ONLY a JSON array (no markdown, no prose) where each element has exactly these keys:
  code        — product/model code or SKU (string, uppercase, required)
  name        — product name (string, required)
  unit_cost   — supplier cost / buy price (number, no currency symbol, null if unknown)
  unit_price  — selling price (number, no currency symbol, null if unknown)

Example output:
[{"code":"SF-001","name":"3-Seater Sofa","unit_cost":450,"unit_price":799},
 {"code":"BK-202","name":"King Bed Frame","unit_cost":380,"unit_price":680}]

If a field is not present in the source, use null for numbers and empty string for strings.
Do NOT include any explanation. Return the JSON array only.`;

// ── routes ───────────────────────────────────────────────────────────────────

// POST /catalogue-import/upload
// Accepts: multipart/form-data with fields: file, supplier_id, category_id
router.post(
  '/upload',
  requireRole(MANAGE_ROLES),
  upload.single('file'),
  async (req, res) => {
    const { company_id, id: created_by } = req.user;
    const { supplier_id, category_id } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = file.originalname.split('.').pop().toLowerCase();
    const isXlsx = ['xlsx', 'xls', 'csv'].includes(ext);
    const source_type = isXlsx ? 'xlsx' : ext === 'pdf' ? 'pdf' : 'photo';

    // 1. Upload to Supabase Storage (catalogue-imports bucket)
    const storagePath = `catalogue-imports/${company_id}/${Date.now()}-${file.originalname}`;
    const { error: uploadError } = await supabase.storage
      .from('catalogue-imports')
      .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      // Non-fatal — continue without storage URL
    }

    const { data: { publicUrl } } = supabase.storage
      .from('catalogue-imports')
      .getPublicUrl(storagePath);

    // 2. Create job record (status: processing)
    const { data: job, error: jobError } = await supabase
      .from('catalogue_import_jobs')
      .insert({
        company_id,
        supplier_id: supplier_id || null,
        category_id: category_id || null,
        source_type,
        source_url: publicUrl || null,
        status: 'processing',
        created_by,
      })
      .select()
      .single();

    if (jobError) return res.status(500).json({ error: jobError.message });

    // 3. Parse file
    let parsedRows = [];
    try {
      if (isXlsx) {
        parsedRows = parseXlsx(file.buffer);
      } else {
        parsedRows = await parseWithVision(file.buffer, file.mimetype);
      }
    } catch (parseErr) {
      console.error('Parse error:', parseErr);
      await supabase.from('catalogue_import_jobs')
        .update({ status: 'failed' })
        .eq('id', job.id);
      return res.status(422).json({ error: 'Failed to parse file: ' + parseErr.message });
    }

    if (parsedRows.length === 0) {
      await supabase.from('catalogue_import_jobs')
        .update({ status: 'failed' })
        .eq('id', job.id);
      return res.status(422).json({ error: 'No products found in file' });
    }

    // 4. Check for duplicates against existing products
    const codes = parsedRows.map(r => r.product_code).filter(Boolean);
    const { data: existingProducts } = await supabase
      .from('products')
      .select('code')
      .eq('company_id', company_id)
      .in('code', codes);

    const existingCodes = new Set((existingProducts || []).map(p => p.code));

    // 5. Insert staging rows
    const stagingRows = parsedRows.map(r => ({
      job_id: job.id,
      raw_data: r,
      product_code: r.product_code || null,
      product_name: r.product_name || null,
      unit_cost: r.unit_cost,
      unit_price: r.unit_price,
      action: existingCodes.has(r.product_code) ? 'duplicate' : 'import',
    }));

    const { data: rows, error: rowsError } = await supabase
      .from('catalogue_import_rows')
      .insert(stagingRows)
      .select();

    if (rowsError) {
      console.error('Rows insert error:', rowsError);
      return res.status(500).json({ error: rowsError.message });
    }

    // 6. Update job to review
    await supabase
      .from('catalogue_import_jobs')
      .update({ status: 'review', ai_raw_output: parsedRows })
      .eq('id', job.id);

    res.json({ job_id: job.id, rows, source_type });
  }
);

// GET /catalogue-import/:job_id — re-open a previous job
router.get('/:job_id', requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { company_id } = req.user;
    const { job_id } = req.params;

    const { data: job, error } = await supabase
      .from('catalogue_import_jobs')
      .select('*, catalogue_import_rows(*)')
      .eq('id', job_id)
      .eq('company_id', company_id)
      .single();

    if (error || !job) return res.status(404).json({ error: 'Job not found' });
    res.json({ job });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /catalogue-import/:job_id/rows — bulk save edits from review screen
router.put('/:job_id/rows', requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { company_id } = req.user;
    const { job_id } = req.params;
    const { rows } = req.body; // [{ id, product_code, product_name, unit_cost, unit_price, action }]

    if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });

    // Verify job belongs to company
    const { data: job } = await supabase
      .from('catalogue_import_jobs')
      .select('id')
      .eq('id', job_id)
      .eq('company_id', company_id)
      .single();

    if (!job) return res.status(404).json({ error: 'Job not found' });

    // Upsert each row (Supabase doesn't have bulk update by id, so we batch)
    const updates = rows.map(r =>
      supabase
        .from('catalogue_import_rows')
        .update({
          product_code: r.product_code?.toUpperCase(),
          product_name: r.product_name,
          unit_cost: r.unit_cost,
          unit_price: r.unit_price,
          action: r.action,
        })
        .eq('id', r.id)
        .eq('job_id', job_id)
    );

    await Promise.all(updates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /catalogue-import/:job_id/commit — insert approved rows into products
router.post('/:job_id/commit', requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { company_id } = req.user;
    const { job_id } = req.params;

    // Verify job
    const { data: job } = await supabase
      .from('catalogue_import_jobs')
      .select('*, catalogue_import_rows(*)')
      .eq('id', job_id)
      .eq('company_id', company_id)
      .single();

    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status === 'done') return res.status(409).json({ error: 'Job already committed' });

    const toImport = (job.catalogue_import_rows || []).filter(r => r.action === 'import');
    const toSkip   = (job.catalogue_import_rows || []).filter(r => r.action !== 'import');

    // Re-check duplicates at commit time (another user may have added since review)
    const codes = toImport.map(r => r.product_code).filter(Boolean);
    const { data: existing } = await supabase
      .from('products')
      .select('code')
      .eq('company_id', company_id)
      .in('code', codes);

    const existingCodes = new Set((existing || []).map(p => p.code));

    let imported = 0;
    let skipped  = toSkip.length;
    const rowUpdates = [];

    for (const row of toImport) {
      if (existingCodes.has(row.product_code)) {
        skipped++;
        rowUpdates.push({ id: row.id, action: 'duplicate', product_id: null });
        continue;
      }

      const { data: product, error: insertErr } = await supabase
        .from('products')
        .insert({
          company_id,
          supplier_id: job.supplier_id || null,
          category_id: job.category_id || null,
          code:        row.product_code,
          name:        row.product_name,
          unit_cost:   row.unit_cost,
          unit_price:  row.unit_price,
          is_standard: true,
          reorder_point: 0,
          is_active:   true,
        })
        .select('id')
        .single();

      if (insertErr) {
        console.error('Insert product error for', row.product_code, insertErr.message);
        skipped++;
        rowUpdates.push({ id: row.id, action: 'skip', product_id: null });
      } else {
        imported++;
        rowUpdates.push({ id: row.id, action: 'import', product_id: product.id });
      }
    }

    // Update row records with product_ids
    await Promise.all(
      rowUpdates.map(u =>
        supabase
          .from('catalogue_import_rows')
          .update({ action: u.action, product_id: u.product_id })
          .eq('id', u.id)
      )
    );

    // Finalise job
    await supabase
      .from('catalogue_import_jobs')
      .update({ status: 'done', rows_imported: imported, rows_skipped: skipped })
      .eq('id', job.id);

    res.json({ imported, skipped, total: toImport.length + toSkip.length });
  } catch (err) {
    console.error('Commit error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
