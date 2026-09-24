# Type C — Legacy soiId Repair Work-List (owed-but-unresolved product incentives)

**Scope:** the unpaid commission line items whose sold product **has an exact
configured incentive** but which the shipped exact-matcher cannot resolve to a
`product_id` (so they correctly pay **RM0 today**, fail-closed). This is the
**separate legacy `soiId` repair scope** — NOT a matcher/config/catalog change.

**Evidence marking: `UNIQUE_REVIEW_MATCH`.** The candidate `product_id` for each
row was obtained by a **read-only, company-wide** identity probe (match on
`product_code` + composed `name`, ignoring qty and order boundaries). This is
**review evidence only** and **must NOT be treated as production identity
resolution** — the shipped matcher deliberately does not resolve these (it
requires an order-scoped, qty-matched, unique key). Do not pay from this list.

**Why unresolved (common cause):** every row is a **multi-SO combined order**
(`so_number` holds several SOs). The order-scoped fallback matches
`code + composed-name + qty` within the tokenized SOs and requires a **qty
match**; on combined orders the legacy line `unit` does not equal the individual
`sales_order_items.quantity`, so it fails closed. Identity is only recoverable
company-wide (unique `code + name`), which is out of the matcher's safe scope.

**Repair path (separate, not done here):** stamp the correct `soiId` onto these
legacy `orders.items` lines (or resolve the catalog so the order-scoped match
succeeds), then a normal recalculation would pay the **configured** rate.

**Repair status (all rows): `PENDING_SOIID_BACKFILL`.**

**Guardrails honored:** no matcher logic change · no config change · no catalog
change · no `soiId` write · no commission mutation · no recalculation · no
deploy. Deployment remains a separate explicit approval step.

---

## Totals

- Orders: **17** · Line items: **22**
- **Expected incentive (at CONFIGURED rates × qty): RM3,070.00**
- Old fuzzy worst-case these rows were showing: RM4,250.00
- Current amount: RM0.00 · New amount (shipped matcher): RM0.00 (correct fail-closed)

`amount_source_note`: `expected_incentive_amount` = configured_rate × qty (the
correct owed figure). `old_fuzzy_worstcase` is the pre-fix inflated figure, for
reference only.

---

## Work-list

`order_id` is emitted by the generator query in the next section (this session
has no DB access to fetch it); rows here are keyed by `so_number`.

| # | order_id | so_number | salesperson | legacy_item_identity | qty | candidate_product_id | configured_rate | expected_incentive_amount | current_amount | new_amount | resolution_failure_reason | repair_status | evidence |
|--:|:--|:--|:--|:--|--:|:--|--:|--:|--:|--:|:--|:--|:--|
| 1 | ⟨gen⟩ | 03184 03185 | Yi Ze | ALESSIO 12.5" Queen (152cm x 190cm) | 1 | ea937d34-e533-4124-ad53-18cabbefda93 | 80 | 80.00 | 0 | 0 | MULTI_SO_ORDER: qty-matched order-scoped key failed | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 2 | ⟨gen⟩ | 03279 & 03280 | Yi Ze | ALESSIO 12.5" Queen (152cm x 190cm) | 1 | ea937d34-e533-4124-ad53-18cabbefda93 | 80 | 80.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 3 | ⟨gen⟩ | 21312 & 21313 | (unassigned) | Pure Breeze Queen (152cm x 190cm) | 1 | fe1bfd67-fa75-4446-a27c-bd83394b2f87 | 100 | 100.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 4 | ⟨gen⟩ | 21525 21526 21530 | Yu Yang / Robbin | VICTORIA 15" King (183cm x 190cm) | 1 | 8bd56864-88f3-4522-a20e-046fb84a55b5 | 150 | 150.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 5 | ⟨gen⟩ | 21525 21526 21530 | Yu Yang / Robbin | ALESSIO 12.5" Queen (152cm x 190cm) | 1 | ea937d34-e533-4124-ad53-18cabbefda93 | 80 | 80.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 6 | ⟨gen⟩ | 21525 21526 21530 | Yu Yang / Robbin | ALESSIO 12.5" Queen (152cm x 190cm) | 2 | ea937d34-e533-4124-ad53-18cabbefda93 | 80 | 160.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 7 | ⟨gen⟩ | 55331 55332 55333 | Qian Hui | ALESSIO 12.5" Queen (152cm x 190cm) | 2 | ea937d34-e533-4124-ad53-18cabbefda93 | 80 | 160.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 8 | ⟨gen⟩ | 55588 54338 | Aliff | Dunlopillo Cool Luxe Queen (152cm x 190cm) | 1 | a975da61-3b9c-4255-9847-09f7515104c1 | 100 | 100.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 9 | ⟨gen⟩ | 55605 55920 | Aliff / Tas | Dunlopillo Cool Luxe King (183cm x 190cm) | 1 | aac1e4d7-2ad9-4963-a9b7-175104fa6208 | 150 | 150.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 10 | ⟨gen⟩ | 55703 55704 | Qian Hui | ALESSIO 12.5" King (183cm x 190cm) | 1 | 4dd154f9-bda4-487c-9ad4-9d6158e0e4d3 | 150 | 150.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 11 | ⟨gen⟩ | 55751 55752 | Austin / Alice / Belinda | ALESSIO 12.5" Queen (152cm x 190cm) | 1 | ea937d34-e533-4124-ad53-18cabbefda93 | 80 | 80.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 12 | ⟨gen⟩ | 55751 55752 | Austin / Alice / Belinda | VICTORIA 15" King (183cm x 190cm) | 1 | 8bd56864-88f3-4522-a20e-046fb84a55b5 | 150 | 150.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 13 | ⟨gen⟩ | 55898 55899 (FLW 56094) | Qian Hui | ALESSIO 12.5" King (183cm x 190cm) | 1 | 4dd154f9-bda4-487c-9ad4-9d6158e0e4d3 | 150 | 150.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 14 | ⟨gen⟩ | 55929 55930 | Wan Ying / Qian Hui | Pure Breeze Queen (152cm x 190cm) | 1 | fe1bfd67-fa75-4446-a27c-bd83394b2f87 | 100 | 100.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 15 | ⟨gen⟩ | 55965 55966 55967 55968 | Marko Beh / Wan Ying | Kensington King (183cm x 190cm) | 2 | 95b7e3e8-2e55-4a91-b6bf-605704925515 | 200 | 400.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 16 | ⟨gen⟩ | 56055 56056 | Wan Ying | Kensington Queen (152cm x 190cm) | 1 | ad1953cf-ea38-44ba-9e22-55b1c7e5c777 | 150 | 150.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 17 | ⟨gen⟩ | 56105 / 56106 / 56107 | Qian Hui | Kensington King (183cm x 190cm) | 1 | 95b7e3e8-2e55-4a91-b6bf-605704925515 | 200 | 200.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 18 | ⟨gen⟩ | 56111 56112 56113 | Jimmy | ALESSIO 12.5" Queen (152cm x 190cm) | 2 | ea937d34-e533-4124-ad53-18cabbefda93 | 80 | 160.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 19 | ⟨gen⟩ | 56114 / 56115 / 56116 | Qian Hui / Bonnie | ALESSIO 12.5" Queen (152cm x 190cm) | 1 | ea937d34-e533-4124-ad53-18cabbefda93 | 80 | 80.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 20 | ⟨gen⟩ | 56114 / 56115 / 56116 | Qian Hui / Bonnie | ALESSIO 12.5" Queen (152cm x 190cm) | 2 | ea937d34-e533-4124-ad53-18cabbefda93 | 80 | 160.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 21 | ⟨gen⟩ | 56191 56192 | Wan Ying / Alice | ALESSIO 12.5" Queen (152cm x 190cm) | 1 | ea937d34-e533-4124-ad53-18cabbefda93 | 80 | 80.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |
| 22 | ⟨gen⟩ | 56191 56192 | Wan Ying / Alice | Dunlopillo Cool Luxe King (183cm x 190cm) | 1 | aac1e4d7-2ad9-4963-a9b7-175104fa6208 | 150 | 150.00 | 0 | 0 | MULTI_SO_ORDER | PENDING_SOIID_BACKFILL | UNIQUE_REVIEW_MATCH |

`⟨gen⟩` = populated by the generator query below (one read-only run).

---

## Generator query (read-only) — emits the authoritative list WITH order_id

Run this to reproduce the table above with `order_id` populated and export to CSV.
It writes nothing. The `UNIQUE_REVIEW_MATCH` candidate is a company-wide identity
probe (review evidence only, never used for payout).

```sql
WITH unpaid AS (SELECT DISTINCT order_id FROM commissions WHERE status<>'paid' AND paid_at IS NULL),
ord AS (SELECT o.id, o.so_number, o.company_id, o.salesman, o.items FROM orders o JOIN unpaid u ON u.order_id=o.id),
items AS (
  SELECT o.id AS order_id, o.so_number, o.salesman, o.company_id, t.idx, t.elem->>'soiId' AS soi_id,
    lower(t.elem->>'itemCode') AS code, t.elem->>'itemName' AS item_name,
    trim(regexp_replace(lower(t.elem->>'itemName'),'\s+',' ','g')) AS name,
    COALESCE(NULLIF(regexp_replace(COALESCE(t.elem->>'unit',''),'[^0-9.]','','g'),'')::numeric,1) AS qty
  FROM ord o CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN o.items IS NULL THEN '[]'::jsonb WHEN jsonb_typeof(o.items)='array' THEN o.items
         WHEN jsonb_typeof(o.items)='string' AND left(o.items #>> '{}',1)='[' THEN (o.items #>> '{}')::jsonb ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS t(elem, idx)
),
prim AS (SELECT i.order_id,i.idx,soi.product_id::text AS pid FROM items i JOIN sales_order_items soi ON soi.id::text=i.soi_id),
so_link AS (SELECT o.id AS order_id, so.id AS soid FROM ord o JOIN sales_orders so ON so.company_id=o.company_id AND so.order_number=ANY(regexp_split_to_array(trim(o.so_number),'[\s,&/()]+'))),
soi_cand AS (SELECT l.order_id, lower(si.product_code) code, trim(regexp_replace(lower(concat_ws(' ',si.product_name,si.size,si.color,si.custom_dimensions)),'\s+',' ','g')) name, si.quantity::numeric qty, si.product_id::text pid FROM so_link l JOIN sales_order_items si ON si.order_id=l.soid),
det AS (SELECT order_id,code,name,qty, CASE WHEN count(DISTINCT pid)=1 THEN min(pid) END pid FROM soi_cand WHERE pid IS NOT NULL GROUP BY order_id,code,name,qty),
resolved AS (SELECT i.*, COALESCE(p.pid,d.pid) AS product_id FROM items i LEFT JOIN prim p ON p.order_id=i.order_id AND p.idx=i.idx LEFT JOIN det d ON d.order_id=i.order_id AND d.code=i.code AND d.name=i.name AND d.qty=i.qty),
active_inc AS (SELECT company_id, product_id::text pid, incentive_amount FROM product_incentives WHERE is_active=true AND (start_date IS NULL OR start_date<=current_date) AND (end_date IS NULL OR end_date>=current_date)),
earning_unresolved AS (
  SELECT r.*, (SELECT max(pi.incentive_amount) FROM product_incentives pi WHERE pi.company_id=r.company_id AND pi.is_active
    AND ((pi.product_code<>'' AND r.code LIKE '%'||lower(pi.product_code)||'%') OR (pi.product_name<>'' AND r.name LIKE '%'||lower(pi.product_name)||'%'))) AS fuzzy_amt_max
  FROM resolved r WHERE r.product_id IS NULL
),
company_soi AS (SELECT so.company_id, lower(si.product_code) code, trim(regexp_replace(lower(concat_ws(' ',si.product_name,si.size,si.color,si.custom_dimensions)),'\s+',' ','g')) name, si.product_id::text pid FROM sales_order_items si JOIN sales_orders so ON so.id=si.order_id),
probe AS (
  SELECT e.order_id, e.so_number, e.salesman, e.item_name, e.qty, e.fuzzy_amt_max,
    array_agg(DISTINCT cs.pid) FILTER (WHERE ai.pid IS NOT NULL) AS configured_pids,
    max(ai.incentive_amount) FILTER (WHERE ai.pid IS NOT NULL) AS configured_rate,
    count(DISTINCT cs.pid) FILTER (WHERE ai.pid IS NOT NULL) AS configured_cand_pids
  FROM earning_unresolved e
  LEFT JOIN company_soi cs ON cs.company_id=e.company_id AND cs.code=e.code AND cs.name=e.name
  LEFT JOIN active_inc ai ON ai.company_id=e.company_id AND ai.pid=cs.pid
  WHERE e.fuzzy_amt_max IS NOT NULL
  GROUP BY e.order_id, e.so_number, e.salesman, e.item_name, e.qty, e.fuzzy_amt_max
)
SELECT
  order_id,
  so_number,
  salesman                                        AS salesperson,
  item_name                                       AS legacy_item_identity,
  qty,
  (configured_pids)[1]                            AS candidate_product_id,
  configured_rate                                 AS configured_incentive_rate,
  ROUND(configured_rate * qty, 2)                 AS expected_incentive_amount,
  0                                               AS current_amount,
  0                                               AS new_amount,
  'MULTI_SO_ORDER: order-scoped qty-matched key failed; identity only recoverable company-wide' AS resolution_failure_reason,
  'PENDING_SOIID_BACKFILL'                        AS repair_status,
  'UNIQUE_REVIEW_MATCH'                            AS evidence
FROM probe
WHERE configured_cand_pids = 1        -- exactly one configured variant (safe, unique)
ORDER BY so_number, legacy_item_identity, qty;
```
