-- Product identity now includes NAME.
--
-- Background: a product's uniqueness within a company was (code, size, color)
-- (migration 003). Some suppliers reuse one model code for several sellable
-- pieces that differ ONLY by a name/variant token — e.g. ANNEX sofa model 8529
-- has pieces "1L" and "1L/W" at the same dimensions, or accessory rows "SP/B",
-- "SP/M", "SP/S" with no size at all. Under the old rule the second, third, …
-- pieces collided on (code, size, color) and were silently dropped at import
-- commit (only rows_skipped incremented — no error surfaced).
--
-- Fix: make name part of the uniqueness so those pieces coexist. Name is
-- normalized to lower(trim(...)) so it matches the application comparison keys
-- (variantKey in server.js and productKey in organization-identity-service.js,
-- both of which lower/trim the name). size and color keep their existing
-- coalesce-only handling from migration 003 — unchanged here to avoid altering
-- the behavior of existing rows.
--
-- Safety: this only ADDS a column to the key, so any set of rows already unique
-- under (company_id, code, size, color) is trivially still unique under
-- (company_id, code, size, color, name). No pre-dedup of the products table is
-- required and the CREATE cannot fail on existing data.
--
-- Run this in the Supabase SQL editor before deploying the matching server code.

drop index if exists products_company_code_size_color_uniq;

create unique index if not exists products_company_code_size_color_name_uniq
  on products (
    company_id,
    code,
    coalesce(size, ''),
    coalesce(color, ''),
    lower(trim(coalesce(name, '')))
  );
