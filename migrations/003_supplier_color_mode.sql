-- Per-supplier colour interpretation, and colour as a variant dimension.
--
-- Some suppliers write "Natural / Walnut" to mean two separate colour options
-- (two variants of one code); others write "Natural/White" to mean a single
-- two-tone product. Which meaning applies is a property of the supplier, so we
-- store it per supplier as color_mode ('split' | 'combined', default 'combined').
--
-- When colours are split into separate variants, two rows share the same code
-- and size but differ by colour — so uniqueness must include colour.
--
-- Run this in the Supabase SQL editor before deploying the matching server code.

-- 1. Per-supplier colour mode, and the resolved mode carried on each import job.
alter table suppliers add column if not exists color_mode text not null default 'combined';
alter table catalogue_import_jobs add column if not exists color_mode text;

-- 2. Move uniqueness from (code, size) to (code, size, colour).
drop index if exists products_company_code_size_uniq;
create unique index if not exists products_company_code_size_color_uniq
  on products (company_id, code, coalesce(size, ''), coalesce(color, ''));
