-- Organization-level product catalogue sharing.
--
-- V Haus Group's three sibling companies (Vhaus Living (PG) Sdn Bhd,
-- Vhaus Living Sdn Bhd, Vhaus Living (KL) Sdn Bhd) are one organization and
-- should share a single product catalogue. company_id on products is kept
-- as creator attribution (who imported/added the row); organization_id
-- becomes the scope used for visibility, lookup and uniqueness.
--
-- Each company previously kept its own independent copy of the catalogue
-- (the same supplier products imported separately into each company), so
-- merging to one organization scope surfaces pre-existing duplicates —
-- the same (code, size, color) showing up once per company. This migration
-- merges those into a single canonical row per group before enforcing the
-- new org-scoped unique index.
--
-- Run this in the Supabase SQL editor before deploying the matching server
-- code. Take a database backup/snapshot first — step 2 deletes rows.

-- 1. Add organization_id, backfilled from each product's company.
alter table products add column if not exists organization_id uuid references organizations(id);

update products p
set organization_id = c.organization_id
from companies c
where p.company_id = c.id and p.organization_id is null;

-- 2. Merge duplicate products. The OLD unique index was scoped per company
--    (company_id, code, size, color), so a single company could never hold
--    two rows in the same duplicate group — every group here spans more
--    than one company. That means repointing references is safe: nothing
--    on the "kept" side can already reference the canonical row for the
--    same company, so no per-company unique constraints downstream can
--    collide. The oldest row (by created_at, then id) in each group is
--    kept as canonical; every other row's references are repointed to it
--    and the row itself is then removed.
do $$
declare dupe_groups int;
begin
  create temporary table product_merge_map as
  select p.id as old_id,
         first_value(p.id) over (
           partition by p.organization_id, p.code, coalesce(p.size, ''), coalesce(p.color, '')
           order by p.created_at asc, p.id asc
         ) as canonical_id
  from products p
  where p.organization_id is not null;

  delete from product_merge_map where old_id = canonical_id;

  select count(distinct canonical_id) into dupe_groups from product_merge_map;
  raise notice 'Merging % duplicate product row(s) across % group(s).', (select count(*) from product_merge_map), dupe_groups;

  -- Repoint every table that references products(id), skipping any that
  -- don't exist in this database.
  if to_regclass('public.inventory') is not null then
    update inventory i set product_id = m.canonical_id
    from product_merge_map m where i.product_id = m.old_id;
  end if;
  if to_regclass('public.stock_movements') is not null then
    update stock_movements s set product_id = m.canonical_id
    from product_merge_map m where s.product_id = m.old_id;
  end if;
  if to_regclass('public.sales_order_items') is not null then
    update sales_order_items s set product_id = m.canonical_id
    from product_merge_map m where s.product_id = m.old_id;
  end if;
  if to_regclass('public.purchase_order_items') is not null then
    update purchase_order_items po set product_id = m.canonical_id
    from product_merge_map m where po.product_id = m.old_id;
  end if;
  if to_regclass('public.package_labels') is not null then
    update package_labels pl set product_id = m.canonical_id
    from product_merge_map m where pl.product_id = m.old_id;
  end if;
  if to_regclass('public.product_incentives') is not null then
    update product_incentives pi set product_id = m.canonical_id
    from product_merge_map m where pi.product_id = m.old_id;
  end if;
  if to_regclass('public.supplier_lead_times') is not null then
    update supplier_lead_times slt set product_id = m.canonical_id
    from product_merge_map m where slt.product_id = m.old_id;
  end if;
  if to_regclass('public.catalogue_import_rows') is not null then
    update catalogue_import_rows cir set product_id = m.canonical_id
    from product_merge_map m where cir.product_id = m.old_id;
  end if;

  -- Remove the now-redundant duplicate product rows.
  delete from products p using product_merge_map m where p.id = m.old_id;

  drop table product_merge_map;
end $$;

-- 3. Defensive guard: confirm no duplicates remain before enforcing the
--    organization-scoped unique index. Should always pass after step 2 —
--    if it doesn't, something outside the expected shape needs a manual
--    look (e.g. a NULL organization_id) before proceeding.
do $$
declare dupe_count int;
begin
  select count(*) into dupe_count
  from (
    select organization_id, code, coalesce(size, '') as size, coalesce(color, '') as color
    from products
    where organization_id is not null
    group by 1, 2, 3, 4
    having count(*) > 1
  ) dupes;

  if dupe_count > 0 then
    raise exception 'products: % organization-scoped (code, size, color) collisions remain after merge — investigate manually', dupe_count;
  end if;
end $$;

-- 4. Drop the old company-scoped unique index, replace with an
--    organization-scoped one. Products with no organization_id (orphaned
--    company, shouldn't normally happen) fall back to company_id so they
--    don't collide with each other across companies.
drop index if exists products_company_code_size_color_uniq;

create unique index if not exists products_org_code_size_color_uniq
  on products (coalesce(organization_id::text, 'company:' || company_id::text), code, coalesce(size, ''), coalesce(color, ''));

-- 5. Lookup index for organization-scoped queries.
create index if not exists idx_products_organization on products (organization_id);
