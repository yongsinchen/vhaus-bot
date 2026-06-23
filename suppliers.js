const express = require('express');
const router = express.Router();
const { supabase } = require('../lib/supabase');
const { requireRole } = require('../middleware/auth');

const MANAGE_ROLES = ['master', 'manager', 'company_admin'];

// GET /suppliers
router.get('/', async (req, res) => {
  try {
    const { company_id } = req.user;
    const { data, error } = await supabase
      .from('suppliers')
      .select('id, name, code, contact, is_active, created_at')
      .eq('company_id', company_id)
      .order('name');

    if (error) throw error;
    res.json({ suppliers: data });
  } catch (err) {
    console.error('GET /suppliers error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /suppliers
router.post('/', requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { company_id } = req.user;
    const { name, code, contact } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { data, error } = await supabase
      .from('suppliers')
      .insert({ company_id, name: name.trim(), code: code?.trim(), contact })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ supplier: data });
  } catch (err) {
    console.error('POST /suppliers error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
