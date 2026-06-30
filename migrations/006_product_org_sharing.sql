-- Organization-level product catalogue sharing.
--
-- V Haus Group's three sibling companies (Vhaus Living (PG) Sdn Bhd,
-- Vhaus Living Sdn Bhd, Vhaus Living (KL) Sdn Bhd) are one organization and
-- should share a single product catalogue. company_id on products is kept
-- as creator attribution (who imported/added the row); organization_id
-- becomes the scope used for visibility, lookup and uniqueness.
--
-- Run this in the Supabase SQL editor before deploying the matching server code.

-- 1. Add organization_id, backfilled from each product's company.
alter table products add column if not exists organization_id uuid references organizations(id);

update products p
set organization_id = c.organization_id
from companies c
where p.company_id = c.id and p.organization_id is null;

-- 2. Guard: the previously-independent per-company catalogues are being
--    merged under one organization scope. If two companies in the same org
--    already used the same (code, size, color), merging would silently
--    collide. Fail loudly instead of dropping data.
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
    raise exception 'products: % organization-scoped (code, size, color) collisions found — resolve duplicates before applying the unique index', dupe_count;
  end if;
end $$;

-- 3. Drop the old company-scoped unique index, replace with an
--    organization-scoped one. Products with no organization_id (orphaned
--    company, shouldn't normally happen) fall back to company_id so they
--    don't collide with each other across companies.
drop index if exists products_company_code_size_color_uniq;

create unique index if not exists products_org_code_size_color_uniq
  on products (coalesce(organization_id::text, 'company:' || company_id::text), code, coalesce(size, ''), coalesce(color, ''));

-- 4. Lookup index for organization-scoped queries.
create index if not exists idx_products_organization on products (organization_id);
