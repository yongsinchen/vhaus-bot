# Migration history notes

Migrations are applied manually; nothing in this repo runs files from this
directory automatically. The numeric prefix is rough ordering, not a unique key.

## 084–092 — historical source, already applied

These files were applied to production but not committed to git until later.
They are tracked here as historical source so the history of 093+ can be read
in full. **Do not re-run them against production.** They are committed
byte-for-byte as originally written, with no edits.

Later migrations build on them. 094, 097, 098, 102 and 103 use the
`delivery_orders` supersession columns from 085. 097, 098, 102 and 103 use
`sales_order_amendments.expected_so_updated_at` from 087 and
`sales_orders.updated_at` from 088. 096 extends the table documented in 086.

## Gaps and duplicates

- **080–083**: missing. The gap already existed before 084 (noted in 093's header).
- **095**: drafted, then retired without being applied (see 098's header).
  Do not recreate it.
- **097**: two files redefine `apply_active_do_amendment`:
  `097_amendment_approval_drop_arrival_requirement.sql` and
  `097_apply_active_do_amendment_remove_arrival_gate.sql`. Both are
  superseded by 098, then 102, then 103.

## `apply_active_do_amendment` lineage

089 → 091 → 092 → 097 → 098 → 102 → **103** (current).

The 097_apply file was rebuilt from 091's body rather than 092's, so 097,
098 and 102 lost 092's fix: a replacement DO kept its delivery remark. 103
restores that fix on top of 102.
