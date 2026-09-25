-- ══════════════════════════════════════════════════════════════════
-- 107: amend / withdraw a PENDING payment (before Finance approval).
--
-- Builds only on migration 105's canonical RPCs — no second ledger formula:
--
--   withdraw_pending_payment  — lock the payment row, require it is still
--     'pending' (and, when given, recorded by p_require_recorded_by), then
--     reverse_allocated_payment(). The status check happens under the row
--     lock, so it can't race a concurrent approve/reject.
--
--   amend_pending_payment     — same checks, then reverse the old payment and
--     record the corrected one INSIDE ONE SAVEPOINT. If either step returns
--     {ok:false} the savepoint rolls back, so the original payment, its
--     allocations and every balance are left exactly as they were. The
--     amended payment keeps the original OR number (the receipt already
--     printed), recorded_by, customer_id, paid_at and idempotency_key, and
--     any bank-statement match is re-pointed to it. It stays 'pending'.
--
-- Both are SECURITY DEFINER and service_role-only, exactly like 105: the
-- backend resolves company / actor / ownership from the session.
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION withdraw_pending_payment(
  p_company_id           UUID,
  p_actor_user_id        UUID,
  p_payment_id           UUID,
  p_require_recorded_by  UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment payments%ROWTYPE;
BEGIN
  SELECT * INTO v_payment FROM payments WHERE id = p_payment_id AND company_id = p_company_id FOR UPDATE;
  IF v_payment.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'payment_not_found', 'error', 'Payment not found');
  END IF;
  IF p_require_recorded_by IS NOT NULL AND v_payment.recorded_by IS DISTINCT FROM p_require_recorded_by THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_owner', 'error', 'Only the person who recorded this payment can change it');
  END IF;
  IF v_payment.approval_status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_decided', 'error', format('Payment is already %s — it can no longer be changed', COALESCE(v_payment.approval_status, 'processed')));
  END IF;
  RETURN reverse_allocated_payment(p_company_id, p_actor_user_id, p_payment_id);
END;
$$;

REVOKE ALL ON FUNCTION withdraw_pending_payment(UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION withdraw_pending_payment(UUID, UUID, UUID, UUID) TO service_role;


CREATE OR REPLACE FUNCTION amend_pending_payment(
  p_company_id           UUID,
  p_actor_user_id        UUID,
  p_payment_id           UUID,
  p_require_recorded_by  UUID,
  p_amount               NUMERIC,
  p_payment_method       TEXT,
  p_reference_no         TEXT,
  p_proof_url            TEXT,
  p_admin_charges        NUMERIC,
  p_kind                 TEXT,
  p_allocations          JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old      payments%ROWTYPE;
  v_new      payments%ROWTYPE;
  v_rev      JSONB;
  v_rec      JSONB;
  v_matches  JSONB;
BEGIN
  SELECT * INTO v_old FROM payments WHERE id = p_payment_id AND company_id = p_company_id FOR UPDATE;
  IF v_old.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'payment_not_found', 'error', 'Payment not found');
  END IF;
  IF p_require_recorded_by IS NOT NULL AND v_old.recorded_by IS DISTINCT FROM p_require_recorded_by THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_owner', 'error', 'Only the person who recorded this payment can change it');
  END IF;
  IF v_old.approval_status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_decided', 'error', format('Payment is already %s — it can no longer be changed', COALESCE(v_old.approval_status, 'processed')));
  END IF;

  -- Bank-statement matches to carry over (reverse unlinks them).
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id::TEXT, 'match_status', match_status)), '[]'::JSONB)
    INTO v_matches FROM statement_transactions WHERE matched_payment_id = p_payment_id;

  BEGIN  -- savepoint: reverse + record succeed together or not at all
    v_rev := reverse_allocated_payment(p_company_id, p_actor_user_id, p_payment_id);
    IF NOT COALESCE((v_rev->>'ok')::BOOLEAN, false) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = v_rev::TEXT;
    END IF;

    -- recorded_by comes from the actor argument, so pass the ORIGINAL
    -- recorder to keep ownership with the person who collected the money.
    v_rec := record_allocated_payment(
      p_company_id, v_old.recorded_by, v_old.customer_id, p_amount, p_payment_method,
      p_reference_no, p_proof_url, p_admin_charges, p_kind, p_allocations,
      v_old.or_number, NULL);
    IF NOT COALESCE((v_rec->>'ok')::BOOLEAN, false) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = v_rec::TEXT;
    END IF;

    UPDATE payments SET paid_at = v_old.paid_at, idempotency_key = v_old.idempotency_key
      WHERE id = (v_rec->'payment'->>'id')::UUID
      RETURNING * INTO v_new;

    UPDATE statement_transactions st
       SET matched_payment_id = v_new.id, match_status = m.match_status
      FROM jsonb_to_recordset(v_matches) AS m(id TEXT, match_status TEXT)
     WHERE st.id::TEXT = m.id;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    -- Everything since the savepoint is rolled back; hand back the RPC's
    -- own {ok:false, code, error, ...} result.
    RETURN SQLERRM::JSONB;
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'payment', to_jsonb(v_new),
    'replaced_payment_id', p_payment_id,
    'old_proof_url', v_old.proof_url,
    'sales_orders', COALESCE(v_rev->'sales_orders', '[]'::JSONB) || COALESCE(v_rec->'sales_orders', '[]'::JSONB)
  );
END;
$$;

REVOKE ALL ON FUNCTION amend_pending_payment(UUID, UUID, UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION amend_pending_payment(UUID, UUID, UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT, JSONB) TO service_role;

-- Verification:
--   SELECT proname FROM pg_proc WHERE proname IN ('withdraw_pending_payment', 'amend_pending_payment');
--   -- On a test pending payment (both must refuse an approved one with code already_decided):
--   SELECT amend_pending_payment('<company>', '<user>', '<payment>', NULL, 100, 'Cash', NULL, NULL, NULL, 'balance',
--          '[{"order_id": <orders.id>, "amount": 100}]'::jsonb);

-- Rollback:
--   DROP FUNCTION IF EXISTS amend_pending_payment(UUID, UUID, UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT, JSONB);
--   DROP FUNCTION IF EXISTS withdraw_pending_payment(UUID, UUID, UUID, UUID);
