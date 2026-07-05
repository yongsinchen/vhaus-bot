// Integration test: linking a custom sales_order_item to a product master
// must ONLY set link fields and must never touch order-level item data.
// Mirrors the update used by POST /product-review-queue/link.
//
// Requires migration 025 (linked_custom_item). Creates a clearly-marked TEST
// sales order, runs the link update, asserts, then deletes everything.
// Run: node scripts/test-link-preserves-options.js
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const SPECS = "Width: 200cm | Colour: Walnut | Handle: Gold";

(async () => {
  let orderId = null;
  let failed = 0;
  const check = (name, ok) => { console.log(`${ok ? "✅" : "❌"} ${name}`); if (!ok) failed++; };
  try {
    const { data: company } = await supabase.from("companies").select("id").limit(1).single();
    const { data: product } = await supabase.from("products").select("id, code, name").limit(1).single();
    if (!company || !product) throw new Error("need at least one company and one product in DB");

    // Temp order + custom item (exactly what the salesman flow creates)
    const { data: order, error: oErr } = await supabase.from("sales_orders").insert({
      company_id: company.id, order_number: `TEST-LINK-${Date.now()}`,
      customer_name: "TEST link-preserves-options", status: "draft", subtotal: 100,
    }).select("id").single();
    if (oErr) throw oErr;
    orderId = order.id;
    const { data: item, error: iErr } = await supabase.from("sales_order_items").insert({
      order_id: orderId, product_id: null, product_code: "CUSTOM-1",
      product_name: "Custom Wardrobe (manual)", size: "L", color: "Walnut",
      is_custom: true, custom_dimensions: SPECS, quantity: 2, unit_price: 50,
      notes: "customer wants soft-close hinges", requires_product_review: true,
    }).select("id").single();
    if (iErr) throw iErr;

    // The exact update POST /product-review-queue/link performs
    const { error: linkErr } = await supabase.from("sales_order_items")
      .update({ product_id: product.id, requires_product_review: false, linked_custom_item: true })
      .in("id", [item.id]);
    if (linkErr) throw linkErr;

    const { data: after } = await supabase.from("sales_order_items")
      .select("*").eq("id", item.id).single();
    // Same merge the API does (attachLinkedProducts) — no FK, so no embed.
    const { data: master } = await supabase.from("products").select("code, name").eq("id", after.product_id).single();
    after.products = master || null;

    check("product_id set to master", after.product_id === product.id);
    check("linked_custom_item flagged", after.linked_custom_item === true);
    check("requires_product_review cleared", after.requires_product_review === false);
    check("is_custom preserved (NOT flipped)", after.is_custom === true);
    check("custom_dimensions (ordered options) preserved", after.custom_dimensions === SPECS);
    check("original ordered name preserved", after.product_name === "Custom Wardrobe (manual)");
    check("original ordered code preserved", after.product_code === "CUSTOM-1");
    check("size preserved", after.size === "L");
    check("color preserved", after.color === "Walnut");
    check("quantity preserved", Number(after.quantity) === 2);
    check("unit_price preserved", Number(after.unit_price) === 50);
    check("remark/notes preserved", after.notes === "customer wants soft-close hinges");
    check("API join returns master info alongside", after.products?.code === product.code);
  } catch (e) {
    console.error("❌ test setup/run failed:", e.message);
    failed++;
  } finally {
    if (orderId) {
      await supabase.from("sales_order_items").delete().eq("order_id", orderId);
      await supabase.from("sales_orders").delete().eq("id", orderId);
      console.log("(cleanup done — test order removed)");
    }
  }
  console.log(failed === 0 ? "\nAll checks passed" : `\n${failed} check(s) FAILED`);
  process.exit(failed > 0 ? 1 : 0);
})();
