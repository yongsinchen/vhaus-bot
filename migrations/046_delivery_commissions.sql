-- ══════════════════════════════════════════════════════════════════
-- 046: delivery_commissions — driver incentive for completing a
-- delivery. One eligible commission PER SALES ORDER, locked in when the
-- order's FIRST delivery trip completes, on the (SG-GST-exclusive)
-- order amount × the company's driver_commission_rate (migration 045).
--
-- Business rule (agreed with the business):
--   * Order 11551, order_amount 5000, rate 2.5%  ->  RM 125, ONCE.
--   * If that order is split into 2+ delivery trips, the commission is
--     still paid ONCE (on the first completed trip) — never per trip.
--   * Reversible: if the sales order is later cancelled/returned, the
--     row is marked 'reversed' (see PATCH /sales-orders/:id/status).
--     A failed delivery ATTEMPT never creates a row in the first place
--     (the trigger is completion, not dispatch), so there is nothing to
--     reverse in that case.
--
-- Kept in a PURPOSE-BUILT table rather than reusing `commissions`
-- (salesman) so the new, delivery-triggered financial logic is fully
-- isolated from the battle-tested salesman path — same reasoning the
-- migration author used for commission_line_breakdown (038).
--
-- Depends on migration 045 (companies.driver_commission_rate).
--
-- Type notes (confirmed against existing migrations):
--   * companies.id / sales_orders.id / delivery_orders.id / users.id = UUID
--   * orders.id = BIGINT (legacy — see migration 015 comment). order_id
--     is nullable here: it is only a convenience anchor for report joins
--     against the legacy orders row; the authoritative once-per-order
--     key is sales_order_id.
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS delivery_commissions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sales_order_id     UUID NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  order_id           BIGINT REFERENCES orders(id) ON DELETE SET NULL, -- legacy anchor (BIGINT — see migration 015)
  delivery_order_id  UUID REFERENCES delivery_orders(id) ON DELETE SET NULL, -- the FIRST completed DO that earned it
  driver_user_id     UUID NOT NULL REFERENCES users(id),              -- resolved via delivery_teams.driver_id
  base_amount        NUMERIC(12,2) NOT NULL DEFAULT 0,                -- SG-GST-exclusive order amount the % was taken on
  rate_pct           NUMERIC(6,3)  NOT NULL DEFAULT 0,                -- snapshot of companies.driver_commission_rate at earn time
  commission_amt     NUMERIC(12,2) NOT NULL DEFAULT 0,               -- round2(base_amount * rate_pct/100)
  -- eligible : earned, awaiting payout | paid : paid out | reversed : clawed back (SO cancelled/returned)
  status             TEXT NOT NULL DEFAULT 'eligible'
                       CHECK (status IN ('eligible', 'paid', 'reversed')),
  payout_month       DATE,                                            -- getPayoutMonth(completed_at): month AFTER delivery
  reversed_at        TIMESTAMPTZ,
  reversal_reason    TEXT,
  paid_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Once-per-sales-order guard (defence in depth behind the JS check) ──
-- At most ONE non-reversed commission may exist per sales order. This is
-- what makes a split (multi-trip) delivery pay the incentive exactly once.
-- Partial (WHERE status <> 'reversed') so that AFTER a reversal a genuine
-- re-delivery of the same order can earn a fresh commission. Concurrent
-- completions of two DOs on the same order race here — the loser gets a
-- unique-violation (23505), which calculateDeliveryCommission() swallows.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_delivery_commission_per_so
  ON delivery_commissions (sales_order_id)
  WHERE status <> 'reversed';

CREATE INDEX IF NOT EXISTS idx_delcomm_company_month
  ON delivery_commissions (company_id, payout_month);
CREATE INDEX IF NOT EXISTS idx_delcomm_driver
  ON delivery_commissions (driver_user_id);
CREATE INDEX IF NOT EXISTS idx_delcomm_order
  ON delivery_commissions (order_id) WHERE order_id IS NOT NULL;

-- Verification:
--   SELECT dc.*, u.name AS driver
--   FROM delivery_commissions dc JOIN users u ON u.id = dc.driver_user_id
--   ORDER BY dc.created_at DESC LIMIT 20;

-- Rollback:
--   DROP TABLE IF EXISTS delivery_commissions;
