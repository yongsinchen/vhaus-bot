-- ══════════════════════════════════════════════════════════════════
-- 110: Photos on service approval requests (companion to 109).
--
-- A salesman's New Service Case form submits a service_requests row; the
-- real case (services row) only exists once a PIC approves it. Photos picked
-- in that form live here until then. On approval, PATCH
-- /service-requests/:id/approve moves them into service_photos for the new
-- case (same files, no re-upload) and deletes these rows. Withdrawing a
-- pending request deletes its rows (FK cascade) and the endpoint removes
-- the files. Rejected requests keep their photos as history.
--
-- Same shape as service_photos. FK type resolved at run time (see 045/109).
-- Additive and non-destructive: no existing table is altered.
-- ══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_type text;
BEGIN
  SELECT data_type INTO v_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'service_requests' AND column_name = 'id';
  IF v_type IS NULL THEN RAISE EXCEPTION 'service_requests.id not found'; END IF;

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS service_request_photos (
      id               BIGSERIAL PRIMARY KEY,
      request_id       %s NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
      company_id       UUID NOT NULL,
      url              TEXT NOT NULL,
      storage_path     TEXT,
      description      TEXT,
      uploaded_by      UUID,
      uploaded_by_name TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  $f$, v_type);
END $$;

CREATE INDEX IF NOT EXISTS idx_service_request_photos_parent ON service_request_photos (request_id, company_id);

-- ── Verification ────────────────────────────────────────────────────
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'service_request_photos' ORDER BY ordinal_position;

-- ── Rollback ────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS service_request_photos;
