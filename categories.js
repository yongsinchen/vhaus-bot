const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireRole } = require('../middleware/auth');

const MANAGE_ROLES = ['master', 'manager', 'company_admin'];

// GET /categories — flat list; frontend builds tree
router.get('/', async (req, res) => {
  try {
    const { company_id } = req.user;
    const { data, error } = await supabase
      .from('product_categories')
      .select('id, name, parent_id, created_at')
      .eq('company_id', company_id)
      .order('name');

    if (error) throw error;
    res.json({ categories: data });
  } catch (err) {
    console.error('GET /categories error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /categories
router.post('/', requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { company_id } = req.user;
    const { name, parent_id } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { data, error } = await supabase
      .from('product_categories')
      .insert({ company_id, name: name.trim(), parent_id: parent_id || null })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ category: data });
  } catch (err) {
    console.error('POST /categories error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
