-- Product size/variant support.
-- A product code (e.g. SD886) can be offered in several sizes at different
-- prices. Each size becomes its own product row, so the uniqueness rule moves
-- from (company_id, code) to (company_id, code, size).
--
-- Run this in the Supabase SQL editor before deploying the matching server code.

-- 1. Size columns
alter table products add column if not exists size text;
alter table catalogue_import_rows add column if not exists size text;

-- 2. Drop the old unique CONSTRAINT on exactly (company_id, code), whatever it's named.
do $$
declare r record;
begin
  for r in
    select con.conname,
           (select array_agg(a.attname order by a.attname)
              from unnest(con.conkey) k
              join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k) as cols
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'products' and con.contype = 'u'
  loop
    if r.cols = array['code','company_id'] then
      execute format('alter table products drop constraint %I', r.conname);
    end if;
  end loop;
end $$;

-- 3. Drop the old unique INDEX on exactly (company_id, code), if it exists as a plain index.
do $$
declare r record;
begin
  for r in
    select i.relname as idxname,
           (select array_agg(a.attname order by a.attname)
              from pg_attribute a
              where a.attrelid = ix.indrelid and a.attnum = any(ix.indkey)) as cols
    from pg_index ix
    join pg_class i on i.oid = ix.indexrelid
    join pg_class t on t.oid = ix.indrelid
    where t.relname = 'products' and ix.indisunique and not ix.indisprimary
  loop
    if r.cols = array['code','company_id'] then
      execute format('drop index if exists %I', r.idxname);
    end if;
  end loop;
end $$;

-- 4. New uniqueness: code is unique per company per size. NULL size is treated
--    as '' so a code with no size still can't be duplicated.
create unique index if not exists products_company_code_size_uniq
  on products (company_id, code, coalesce(size, ''));
