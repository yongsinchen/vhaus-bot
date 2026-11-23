-- READ ONLY. The SV number create_service_case() will try next, and the order row (if any) that already holds it.
-- lpad(...,3) TRUNCATES: running number 1000 → "SV-100". A row here = the cause of "orders_so_number_company_unique" (migration 128 fixes it).
WITH nx AS (
  SELECT COALESCE(MAX(n), 0) + 1 AS next FROM (
    SELECT NULLIF(regexp_replace(sv_number, '\D', '', 'g'), '')::int AS n FROM orders WHERE sv_number IS NOT NULL
    UNION ALL
    SELECT NULLIF(regexp_replace(sv_number, '\D', '', 'g'), '')::int AS n FROM order_trips WHERE sv_number IS NOT NULL
  ) s
)
SELECT nx.next AS next_running_number, 'SV-' || lpad(nx.next::text, 3, '0') AS next_sv_number_as_built,
       c.name AS company, o.id, o.so_number, o.sv_number, o.type, o.status, o.customer_name, o.created_at
FROM nx
LEFT JOIN orders o ON o.so_number = 'SV-' || lpad(nx.next::text, 3, '0')
LEFT JOIN companies c ON c.id = o.company_id;
