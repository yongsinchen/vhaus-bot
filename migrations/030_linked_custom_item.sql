-- 025: preserve custom-item history through product-master linking.
-- Linking a reviewed custom item to a product master used to flip
-- sales_order_items.is_custom to false, which hid the item's ordered
-- options in the UI. is_custom now stays untouched on link; this flag
-- records "was a custom/manual item, later linked to a master product"
-- so the UI can show both the original ordered details and the link.
ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS linked_custom_item BOOLEAN NOT NULL DEFAULT false;
