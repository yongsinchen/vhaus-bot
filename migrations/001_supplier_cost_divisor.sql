-- Catalogue costing: derive supplier cost from the catalogue price.
-- When a supplier has cost_divisor set (e.g. 3), importing its catalogue
-- computes unit_cost = unit_price / cost_divisor (RM 2000 → RM 666.67).
-- A NULL cost_divisor means "use the cost printed in the catalogue as-is".
--
-- Run this in the Supabase SQL editor before deploying the matching server code.

alter table suppliers
  add column if not exists cost_divisor numeric;

-- The resolved divisor for each import job, so background processing applies
-- the same costing rule that was chosen at upload time.
alter table catalogue_import_jobs
  add column if not exists cost_divisor numeric;
