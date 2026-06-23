const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireRole } = require('../middleware/auth');

const MANAGE_ROLES = ['master', 'manager', 'company_admin'];

// GET /products
// Query params: search, supplier_id, category_id, is_active (true/false/all), page, limit
router.get('/', async (req, res) => {
  try {
    const { company_id } = req.user;
    const { search, supplier_id, category_id, is_active, page = 1, limit = 50 } = req.query;

    let query = supabase
      .from('products')
      .select(`
        id, code, name, description, unit_cost, unit_price,
        is_standard, reorder_point, is_active, created_at,
        suppliers ( id, name ),
        product_categories ( id, name )
      `, { count: 'exact' })
      .eq('company_id', company_id)
      .order('name', { ascending: true })
      .range((page - 1) * limit, page * limit - 1);

    if (search) {
      query = query.or(`name.ilike.%${search}%,code.ilike.%${search}%`);
    }
    if (supplier_id) query = query.eq('supplier_id', supplier_id);
    if (category_id) query = query.eq('category_id', category_id);
    if (is_active === 'true') query = query.eq('is_active', true);
    if (is_active === 'false') query = query.eq('is_active', false);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({ products: data, total: count, page: Number(page), limit: Number(limit) });
  } catch (err) {
    console.error('GET /products error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /products — create single product
router.post('/', requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { company_id } = req.user;
    const { code, name, description, supplier_id, category_id,
            unit_cost, unit_price, is_standard, reorder_point } = req.body;

    if (!code || !name) {
      return res.status(400).json({ error: 'code and name are required' });
    }

    const { data, error } = await supabase
      .from('products')
      .insert({
        company_id,
        code: code.trim().toUpperCase(),
        name: name.trim(),
        description,
        supplier_id: supplier_id || null,
        category_id: category_id || null,
        unit_cost: unit_cost ?? null,
        unit_price: unit_price ?? null,
        is_standard: is_standard !== false,
        reorder_point: reorder_point ?? 0,
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: `Product code "${code}" already exists` });
      }
      throw error;
    }

    res.status(201).json({ product: data });
  } catch (err) {
    console.error('POST /products error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /products/:id — update product
router.put('/:id', requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { company_id } = req.user;
    const { id } = req.params;
    const { code, name, description, supplier_id, category_id,
            unit_cost, unit_price, is_standard, reorder_point, is_active } = req.body;

    const { data, error } = await supabase
      .from('products')
      .update({
        code: code?.trim().toUpperCase(),
        name: name?.trim(),
        description,
        supplier_id: supplier_id || null,
        category_id: category_id || null,
        unit_cost: unit_cost ?? null,
        unit_price: unit_price ?? null,
        is_standard,
        reorder_point,
        is_active,
      })
      .eq('id', id)
      .eq('company_id', company_id)
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: `Product code "${code}" already exists` });
      }
      throw error;
    }
    if (!data) return res.status(404).json({ error: 'Product not found' });

    res.json({ product: data });
  } catch (err) {
    console.error('PUT /products/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /products/:id/toggle — toggle is_active
router.patch('/:id/toggle', requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { company_id } = req.user;
    const { id } = req.params;

    const { data: existing } = await supabase
      .from('products')
      .select('is_active')
      .eq('id', id)
      .eq('company_id', company_id)
      .single();

    if (!existing) return res.status(404).json({ error: 'Product not found' });

    const { data, error } = await supabase
      .from('products')
      .update({ is_active: !existing.is_active })
      .eq('id', id)
      .select('id, is_active')
      .single();

    if (error) throw error;
    res.json({ product: data });
  } catch (err) {
    console.error('PATCH /products/:id/toggle error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
