-- Migration 050: manager switch for a sales order's product incentive
--
-- Some sales orders should not earn their product incentive. Eligibility is purely
-- the manager's decision — nothing derives it — so this is a plain on/off flag set
-- via PATCH /commissions/order/:orderId/product-incentive (COMMISSION_APPROVE, i.e.
-- master/director/manager only).
--
-- calculateCommission reads this flag back off the existing commission row and
-- re-applies it, so the decision survives "Recalculate All". Without that, every
-- recalculation would silently switch the incentive back on.
--
-- product_incentive_amt keeps holding the amount that WOULD be payable, so the UI can
-- show what is being excluded. Only commission_amt changes:
--   commission_amt = tier + clearance + (waived ? 0 : product_incentive) + package
--
-- ⚠ DO NOT ADD A FOREIGN KEY ON product_incentive_waived_by.
-- The first version of this migration declared `REFERENCES users(id)`. That gave
-- `commissions` a SECOND foreign key to `users` (alongside user_id), and PostgREST
-- cannot resolve an embedded `users(...)` select when two relationships to the same
-- table exist — it fails with PGRST201 instead of returning rows. Every commission
-- query in server.js embeds `users(name, salesman_name)`, so the whole Commission
-- page went blank in production until the column was dropped. A plain UUID stores
-- the same id and keeps the audit trail without declaring a relationship.
--
-- Adding a NOT NULL column with a constant default does not rewrite the table on
-- PostgreSQL 11+, so this is safe on the existing commissions rows. Every row
-- defaults to FALSE (incentive ON), which is the pre-existing behaviour, so no
-- commission amount moves as a result of this migration.
--
-- Rollback:
--   ALTER TABLE commissions DROP COLUMN product_incentive_waived;
--   ALTER TABLE commissions DROP COLUMN product_incentive_waived_by;
--   ALTER TABLE commissions DROP COLUMN product_incentive_waived_at;
-- Dropping does NOT restore commission_amt on rows already switched off — re-run
-- POST /commissions/recalculate-all afterwards to rebuild those amounts. Note also
-- that the deployed calculateCommission READS product_incentive_waived and throws if
-- it is missing, so do not drop these columns while that code is live.

ALTER TABLE commissions
ADD COLUMN IF NOT EXISTS product_incentive_waived BOOLEAN NOT NULL DEFAULT FALSE;

-- Who switched it off and when. A change to a payable amount should never be
-- anonymous. Intentionally NOT a foreign key — see the warning above. Nullable
-- because every existing row predates the feature.
ALTER TABLE commissions
ADD COLUMN IF NOT EXISTS product_incentive_waived_by UUID;

ALTER TABLE commissions
ADD COLUMN IF NOT EXISTS product_incentive_waived_at TIMESTAMPTZ;

-- Verification — every existing row must default to "not waived", and no
-- commission_amt should have moved:
--
--   SELECT product_incentive_waived, COUNT(*) FROM commissions GROUP BY 1;
--   -- expect: false | <all rows>
--
-- And confirm no second relationship to users was created — there must be exactly
-- one foreign key from commissions to users (user_id):
--
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid = 'commissions'::regclass AND contype = 'f';
--
-- Orders with the incentive switched off, and what each withholds:
--
--   SELECT c.id, o.so_number, u.name AS salesman, c.product_incentive_amt AS excluded,
--          c.commission_amt, c.product_incentive_waived_at
--   FROM commissions c
--   LEFT JOIN orders o ON o.id = c.order_id
--   LEFT JOIN users  u ON u.id = c.user_id
--   WHERE c.product_incentive_waived
--   ORDER BY c.product_incentive_waived_at DESC;
