require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function findOrCreateCustomer(company_id, name, phone, address) {
  name = (name || "").trim();
  phone = (phone || "").trim();
  if (!name && !phone) return null;
  if (phone) {
    const { data: existing } = await supabase.from("customers")
      .select("id").eq("company_id", company_id).eq("phone", phone).maybeSingle();
    if (existing) return existing.id;
  }
  const { data: created, error } = await supabase.from("customers").insert({
    company_id, name: name || phone, phone: phone || null, address: address || null,
  }).select("id").single();
  if (error) { console.error("create error for", name, phone, error.message); return null; }
  return created?.id || null;
}

(async () => {
  const { data: rows } = await supabase.from('orders')
    .select('id,so_number,customer_name,contact,address,company_id')
    .is('customer_id', null).not('customer_name', 'is', null);
  console.log(`Backfilling ${rows.length} orders...`);
  let updated = 0;
  for (const o of rows) {
    const custId = await findOrCreateCustomer(o.company_id, o.customer_name, o.contact, o.address);
    if (custId) {
      const { error } = await supabase.from('orders').update({ customer_id: custId }).eq('id', o.id);
      if (error) console.error('update error', o.so_number, error.message);
      else { updated++; console.log(`linked ${o.so_number} -> customer ${custId}`); }
    } else {
      console.log(`skipped ${o.so_number} (no name/phone)`);
    }
  }
  console.log(`Done. ${updated}/${rows.length} linked.`);
})();
