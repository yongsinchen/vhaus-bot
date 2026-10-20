-- ══════════════════════════════════════════════════════════════════
-- 121: Telegram report dispatch ledger — TG-02 Daily Delivery Report.
-- NOT APPLIED. Apply before enabling TG-02 sends (the job fails closed
-- without it: every company errors at the claim step, nothing is sent).
--
-- One row per (company, report type, Malaysia report date) = one LOGICAL
-- report. The row is the only thing that decides whether a report may be
-- (re)sent, so concurrent workers, restarts, overlapping cron runs and
-- retries can never produce a second logical report for a company/date:
--
--   claim        INSERT … ON CONFLICT DO NOTHING, then the row is locked
--                (FOR UPDATE) and judged:
--                  sent         → already_sent (never posted again)
--                  uncertain    → uncertain (needs a human; never automatic)
--                  in_progress  → busy while the lease is live; after the
--                                 lease expires: uncertain if a part was in
--                                 flight (it may have been delivered), else
--                                 taken over
--                  failed       → claimed again (resumes after the last
--                                 confirmed part), up to p_max_attempts
--   freeze_parts the rendered parts + chat are frozen on the row before the
--                first send, so a resumed report finishes the SAME message
--                instead of mixing two different renderings;
--   begin_part   marks part k as in flight BEFORE it is sent;
--   part_sent    records Telegram's message_id for part k only after
--                Telegram confirmed it; the last part makes the row 'sent';
--   fail         'failed' = Telegram definitely did not take the part
--                (safe to resend); 'uncertain' = it may have (timeout / no
--                response) — never resent automatically;
--   resolve      operator decision for an 'uncertain' row after checking the
--                chat: 'delivered' or 'not_delivered'.
--
-- Telegram's Bot API has no idempotency key, so a part whose send outcome is
-- unknown can only be delivered at-most-once (wait for a human) or
-- at-least-once (risk a duplicate). This ledger chooses at-most-once.
--
-- Service-role only (RLS on, no anon/authenticated access).
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS telegram_report_dispatches (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           UUID NOT NULL REFERENCES companies(id),
  report_type          TEXT NOT NULL CHECK (length(btrim(report_type)) > 0),
  report_date          DATE NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('in_progress', 'sent', 'failed', 'uncertain')),
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  claim_token          UUID,
  lease_expires_at     TIMESTAMPTZ,
  chat_id              TEXT,
  parts                JSONB,
  parts_sent           INTEGER NOT NULL DEFAULT 0,
  in_flight_part       INTEGER,
  telegram_message_ids JSONB NOT NULL DEFAULT '[]'::JSONB,
  last_error           TEXT,
  resolution_note      TEXT,
  resolved_at          TIMESTAMPTZ,
  sent_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT telegram_report_dispatches_one_per_day UNIQUE (company_id, report_type, report_date)
);
CREATE INDEX IF NOT EXISTS telegram_report_dispatches_open
  ON telegram_report_dispatches (report_type, report_date) WHERE status <> 'sent';

ALTER TABLE telegram_report_dispatches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON telegram_report_dispatches FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON telegram_report_dispatches TO service_role;

-- ── claim ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tg_report_claim(p_company_id UUID, p_report_type TEXT, p_report_date DATE, p_lease_seconds INTEGER, p_max_attempts INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r telegram_report_dispatches%ROWTYPE;
  v_token UUID := gen_random_uuid();
BEGIN
  IF p_company_id IS NULL OR p_report_type IS NULL OR p_report_date IS NULL THEN RAISE EXCEPTION 'tg_report_claim: company, report type and date are required'; END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'tg_report_claim: lease must be 30–3600 seconds'; END IF;
  IF p_max_attempts IS NULL OR p_max_attempts < 1 THEN RAISE EXCEPTION 'tg_report_claim: max attempts must be >= 1'; END IF;

  INSERT INTO telegram_report_dispatches (company_id, report_type, report_date, status, claim_token, lease_expires_at, attempt_count)
  VALUES (p_company_id, p_report_type, p_report_date, 'in_progress', v_token, now() + make_interval(secs => p_lease_seconds), 1)
  ON CONFLICT (company_id, report_type, report_date) DO NOTHING
  RETURNING * INTO r;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'claimed', 'dispatch_id', r.id, 'claim_token', v_token, 'attempt', 1, 'parts', NULL, 'chat_id', NULL, 'parts_sent', 0);
  END IF;

  SELECT * INTO r FROM telegram_report_dispatches
   WHERE company_id = p_company_id AND report_type = p_report_type AND report_date = p_report_date
   FOR UPDATE;

  IF r.status = 'sent' THEN
    RETURN jsonb_build_object('outcome', 'already_sent', 'dispatch_id', r.id, 'sent_at', r.sent_at);
  END IF;
  IF r.status = 'uncertain' THEN
    RETURN jsonb_build_object('outcome', 'uncertain', 'dispatch_id', r.id, 'in_flight_part', r.in_flight_part, 'parts_sent', r.parts_sent);
  END IF;
  IF r.status = 'in_progress' THEN
    IF r.lease_expires_at > now() THEN
      RETURN jsonb_build_object('outcome', 'busy', 'dispatch_id', r.id);
    END IF;
    IF r.in_flight_part IS NOT NULL THEN
      -- The previous worker died (or hung past its lease) while a part was being sent:
      -- Telegram may have delivered it. Never resend automatically.
      UPDATE telegram_report_dispatches
         SET status = 'uncertain',
             last_error = format('lease expired while part %s was being sent — delivery unknown', r.in_flight_part),
             updated_at = now()
       WHERE id = r.id;
      RETURN jsonb_build_object('outcome', 'uncertain', 'dispatch_id', r.id, 'in_flight_part', r.in_flight_part, 'parts_sent', r.parts_sent);
    END IF;
  END IF;

  -- 'failed', or an expired in_progress lease with nothing in flight.
  IF r.attempt_count >= p_max_attempts THEN
    IF r.status = 'in_progress' THEN
      UPDATE telegram_report_dispatches SET status = 'failed', claim_token = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = r.id;
    END IF;
    RETURN jsonb_build_object('outcome', 'gave_up', 'dispatch_id', r.id, 'attempts', r.attempt_count, 'last_error', r.last_error);
  END IF;

  UPDATE telegram_report_dispatches
     SET status = 'in_progress', claim_token = v_token, lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempt_count = attempt_count + 1, updated_at = now()
   WHERE id = r.id
  RETURNING * INTO r;
  RETURN jsonb_build_object('outcome', 'claimed', 'dispatch_id', r.id, 'claim_token', v_token, 'attempt', r.attempt_count,
                            'parts', r.parts, 'chat_id', r.chat_id, 'parts_sent', r.parts_sent);
END;
$$;

-- ── freeze_parts ──────────────────────────────────────────────────
-- First attempt (nothing sent yet): store the freshly rendered parts + chat.
-- Resume (parts_sent > 0): keep what is stored — the caller must finish THAT report.
CREATE OR REPLACE FUNCTION tg_report_freeze_parts(p_dispatch_id UUID, p_claim_token UUID, p_chat_id TEXT, p_parts JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r telegram_report_dispatches%ROWTYPE;
BEGIN
  SELECT * INTO r FROM telegram_report_dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'in_progress' OR r.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lost_claim');
  END IF;
  IF r.parts_sent > 0 THEN
    RETURN jsonb_build_object('ok', true, 'resumed', true, 'parts', r.parts, 'chat_id', r.chat_id, 'parts_sent', r.parts_sent);
  END IF;
  IF p_parts IS NULL OR jsonb_typeof(p_parts) <> 'array' OR jsonb_array_length(p_parts) = 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_parts) e WHERE jsonb_typeof(e) <> 'string') THEN
    RAISE EXCEPTION 'tg_report_freeze_parts: parts must be a non-empty array of strings';
  END IF;
  IF p_chat_id IS NULL OR btrim(p_chat_id) = '' THEN RAISE EXCEPTION 'tg_report_freeze_parts: chat id is required'; END IF;
  UPDATE telegram_report_dispatches SET parts = p_parts, chat_id = p_chat_id, updated_at = now() WHERE id = r.id;
  RETURN jsonb_build_object('ok', true, 'resumed', false, 'parts', p_parts, 'chat_id', p_chat_id, 'parts_sent', 0);
END;
$$;

-- ── begin_part ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tg_report_begin_part(p_dispatch_id UUID, p_claim_token UUID, p_part INTEGER, p_lease_seconds INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r telegram_report_dispatches%ROWTYPE;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'tg_report_begin_part: lease must be 30–3600 seconds'; END IF;
  SELECT * INTO r FROM telegram_report_dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'in_progress' OR r.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lost_claim');
  END IF;
  IF r.parts IS NULL OR r.in_flight_part IS NOT NULL OR p_part IS DISTINCT FROM r.parts_sent + 1 OR p_part > jsonb_array_length(r.parts) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'out_of_order');
  END IF;
  UPDATE telegram_report_dispatches
     SET in_flight_part = p_part, lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
   WHERE id = r.id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── part_sent ─────────────────────────────────────────────────────
-- Accepted from the claim holder even if a takeover already judged the row
-- 'uncertain' (the holder hung past its lease, then Telegram answered): the
-- confirmation is real, so it settles the uncertainty.
CREATE OR REPLACE FUNCTION tg_report_part_sent(p_dispatch_id UUID, p_claim_token UUID, p_part INTEGER, p_message_id BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r telegram_report_dispatches%ROWTYPE; v_done BOOLEAN;
BEGIN
  SELECT * INTO r FROM telegram_report_dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND OR r.status NOT IN ('in_progress', 'uncertain') OR r.claim_token IS DISTINCT FROM p_claim_token OR r.in_flight_part IS DISTINCT FROM p_part THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lost_claim');
  END IF;
  v_done := p_part = jsonb_array_length(r.parts);
  UPDATE telegram_report_dispatches
     SET parts_sent = p_part, in_flight_part = NULL,
         telegram_message_ids = telegram_message_ids || to_jsonb(p_message_id),
         status = CASE WHEN v_done THEN 'sent' ELSE 'in_progress' END,
         sent_at = CASE WHEN v_done THEN now() ELSE sent_at END,
         claim_token = CASE WHEN v_done THEN NULL ELSE claim_token END,
         lease_expires_at = CASE WHEN v_done THEN NULL ELSE lease_expires_at END,
         last_error = CASE WHEN v_done THEN NULL ELSE last_error END,
         updated_at = now()
   WHERE id = r.id;
  RETURN jsonb_build_object('ok', true, 'status', CASE WHEN v_done THEN 'sent' ELSE 'in_progress' END);
END;
$$;

-- ── fail ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tg_report_fail(p_dispatch_id UUID, p_claim_token UUID, p_outcome TEXT, p_error TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r telegram_report_dispatches%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('failed', 'uncertain') THEN RAISE EXCEPTION 'tg_report_fail: outcome must be failed or uncertain'; END IF;
  SELECT * INTO r FROM telegram_report_dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'in_progress' OR r.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lost_claim');
  END IF;
  IF p_outcome = 'uncertain' AND r.in_flight_part IS NULL THEN
    RAISE EXCEPTION 'tg_report_fail: uncertain needs a part in flight';
  END IF;
  UPDATE telegram_report_dispatches
     SET status = p_outcome,
         in_flight_part = CASE WHEN p_outcome = 'failed' THEN NULL ELSE in_flight_part END,
         claim_token = CASE WHEN p_outcome = 'failed' THEN NULL ELSE claim_token END,
         lease_expires_at = NULL,
         last_error = left(coalesce(p_error, p_outcome), 500),
         updated_at = now()
   WHERE id = r.id;
  RETURN jsonb_build_object('ok', true, 'status', p_outcome);
END;
$$;

-- ── resolve (operator) ────────────────────────────────────────────
-- 'delivered':     the in-flight part is in the chat → counted as sent; the
--                  report is 'sent' if it was the last part, else 'failed'
--                  (the next run resumes with the following part).
-- 'not_delivered': the in-flight part is not in the chat → 'failed'; the next
--                  run resends it.
CREATE OR REPLACE FUNCTION tg_report_resolve(p_dispatch_id UUID, p_resolution TEXT, p_note TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r telegram_report_dispatches%ROWTYPE; v_status TEXT; v_sent INTEGER;
BEGIN
  IF p_resolution NOT IN ('delivered', 'not_delivered') THEN RAISE EXCEPTION 'tg_report_resolve: resolution must be delivered or not_delivered'; END IF;
  IF p_note IS NULL OR btrim(p_note) = '' THEN RAISE EXCEPTION 'tg_report_resolve: a note is required'; END IF;
  SELECT * INTO r FROM telegram_report_dispatches WHERE id = p_dispatch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tg_report_resolve: dispatch not found'; END IF;
  IF r.status <> 'uncertain' OR r.in_flight_part IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_uncertain', 'status', r.status);
  END IF;
  v_sent := CASE WHEN p_resolution = 'delivered' THEN r.in_flight_part ELSE r.parts_sent END;
  v_status := CASE WHEN v_sent = jsonb_array_length(r.parts) THEN 'sent' ELSE 'failed' END;
  UPDATE telegram_report_dispatches
     SET status = v_status, parts_sent = v_sent, in_flight_part = NULL, claim_token = NULL, lease_expires_at = NULL,
         sent_at = CASE WHEN v_status = 'sent' THEN now() ELSE sent_at END,
         resolution_note = left(format('%s: %s', p_resolution, btrim(p_note)), 500), resolved_at = now(), updated_at = now()
   WHERE id = r.id;
  RETURN jsonb_build_object('ok', true, 'status', v_status, 'parts_sent', v_sent);
END;
$$;

REVOKE ALL ON FUNCTION tg_report_claim(UUID, TEXT, DATE, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_report_freeze_parts(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_report_begin_part(UUID, UUID, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_report_part_sent(UUID, UUID, INTEGER, BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_report_fail(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_report_resolve(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION tg_report_claim(UUID, TEXT, DATE, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION tg_report_freeze_parts(UUID, UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION tg_report_begin_part(UUID, UUID, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION tg_report_part_sent(UUID, UUID, INTEGER, BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION tg_report_fail(UUID, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION tg_report_resolve(UUID, TEXT, TEXT) TO service_role;

-- Verification (after applying):
--   SELECT count(*) FROM telegram_report_dispatches;                         -- 0
--   SELECT proname FROM pg_proc WHERE proname LIKE 'tg\_report\_%' ORDER BY 1; -- 6 functions
-- Rollback (only while no report has been sent through it):
--   DROP FUNCTION tg_report_claim(UUID, TEXT, DATE, INTEGER, INTEGER), tg_report_freeze_parts(UUID, UUID, TEXT, JSONB),
--     tg_report_begin_part(UUID, UUID, INTEGER, INTEGER), tg_report_part_sent(UUID, UUID, INTEGER, BIGINT),
--     tg_report_fail(UUID, UUID, TEXT, TEXT), tg_report_resolve(UUID, TEXT, TEXT);
--   DROP TABLE telegram_report_dispatches;
