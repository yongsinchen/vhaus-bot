#!/usr/bin/env node
/**
 * Migration 128 — create_service_case() numbering past SV-999 — REAL PostgreSQL (PGlite; production never touched).
 *
 * Reproduces 2026-11-23 in production: the running number reached 1000 and 'SV-' || lpad('1000', 3, '0') TRUNCATES to
 * "SV-100" — the first such case was saved as SV-100, every later one clashed on "orders_so_number_company_unique".
 * Applies migration 128 to (a) the original function and (b) a function where the first draft of the patch (skip loop
 * with the truncating lpad) was already applied, and checks: SV-1000, SV-1001 … are created; numbers below 1000 keep
 * the 3-digit padding; a number already used in the company is skipped; the patch refuses to run twice; SECURITY
 * DEFINER kept; the diagnostic shows the truncation.
 *
 * Usage: node scripts/test-128-service-number-skip-taken-pg.js
 */
const fs = require("fs");
const path = require("path");
const { createTestDb, loadFunctions, REPO } = require("./pg/pglite-db");
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const A = "00000000-0000-4000-8000-000000000001", PG = "00000000-0000-4000-8000-000000000002", U = "00000000-0000-4000-8000-000000000011";
const patch = fs.readFileSync(path.join(REPO, "migrations", "128_service_number_skip_taken.sql"), "utf8");
const diag = fs.readFileSync(path.join(REPO, "scripts", "sql", "128_diagnose_service_number.sql"), "utf8");
// The first draft of 128 (skip loop, truncating lpad) — production may have it applied.
const FIRST_DRAFT = `DO $fix$ DECLARE d text; n text; BEGIN
  d := pg_get_functiondef('create_service_case(uuid,integer,uuid,bigint,text,uuid,text,text,text,text,text,text,text,bigint,bigint)'::regprocedure);
  n := replace(d, $old$v_sv := 'SV-' || lpad(v_seq::text, 3, '0');$old$,
$new$v_sv := 'SV-' || lpad(v_seq::text, 3, '0');
  WHILE EXISTS (SELECT 1 FROM orders WHERE company_id = p_company_id AND so_number = v_sv) LOOP
    v_seq := v_seq + 1;
    v_sv := 'SV-' || lpad(v_seq::text, 3, '0');
  END LOOP;$new$);
  EXECUTE n; END $fix$;`;

async function mk(seedRows) {
  const db = await createTestDb();
  await loadFunctions(db, "069_service_type_delivery_plain.sql");
  await db.exec(`CREATE SEQUENCE orders_id_seq START 10000; ALTER TABLE orders ALTER COLUMN id SET DEFAULT nextval('orders_id_seq');
    ALTER TABLE services ALTER COLUMN id SET DEFAULT gen_random_uuid(); ALTER TABLE service_legs ALTER COLUMN id SET DEFAULT gen_random_uuid();
    CREATE UNIQUE INDEX orders_so_number_company_unique ON orders (company_id, so_number);
    INSERT INTO companies (id, name) VALUES ('${A}', 'V Haus Living Sdn Bhd'), ('${PG}', 'V Haus Living (PG) Sdn Bhd');
    ${seedRows}`);
  return db;
}
// Production shape: up to SV-999, PG's old SV-100, KL's SV-100 created today by the truncation.
const PROD = `INSERT INTO orders (id, company_id, so_number, sv_number, type, status) VALUES
  (1, '${A}', 'SV-101', 'SV-101', 'Service', 'Pending'), (2, '${A}', 'SV-999', 'SV-999', 'Service', 'Pending'),
  (3, '${PG}', 'SV-100', 'SV-100', 'Service', 'Cancelled'), (4, '${A}', 'SV-100', 'SV-100', 'Service', 'Pending');`;
const create = (db, co = A) => db.query(`SELECT create_service_case($1::uuid, 1, $2::uuid, NULL, 'test', NULL, 'Cust', '0123', 'Addr') r`, [co, U]);
const tryCreate = async (db, co) => { try { return { r: (await create(db, co)).rows[0].r }; } catch (e) { return { err: e.message }; } };

(async () => {
  console.log("\n── production reproduction ──");
  let db = await mk(PROD);
  const d = (await db.query(diag)).rows;
  assert("diagnostic: running number 1000 is built as \"SV-100\" (truncated) and shows both SV-100 rows", d.length === 2 && d.every(r => Number(r.next_running_number) === 1000 && r.next_sv_number_as_built === "SV-100"), JSON.stringify(d));
  let t = await tryCreate(db);
  assert("before 128: New Service Case fails exactly like production", /orders_so_number_company_unique/.test(t.err || ""), JSON.stringify(t));

  console.log("\n── 128 on the original function ──");
  await db.exec(patch);
  t = await tryCreate(db);
  assert("next case is SV-1000 (no truncation)", t.r?.sv_number === "SV-1000", JSON.stringify(t).slice(0, 160));
  t = await tryCreate(db);
  assert("then SV-1001", t.r?.sv_number === "SV-1001");
  t = await tryCreate(db, PG);
  assert("PG company continues from the shared running number (SV-1002)", t.r?.sv_number === "SV-1002");
  let err = null; try { await db.exec(patch); } catch (e) { err = e.message; }
  assert("running 128 twice is refused harmlessly", /already applied/.test(err || ""), err);
  assert("SECURITY DEFINER kept", (await db.query("SELECT prosecdef FROM pg_proc WHERE proname = 'create_service_case'")).rows[0].prosecdef === true);

  console.log("\n── 128 after the FIRST DRAFT was applied ──");
  db = await mk(PROD);
  await db.exec(FIRST_DRAFT);
  t = await tryCreate(db);
  assert("first draft alone gives a WRONG number (truncated SV-10x)", /^SV-10\d$/.test(t.r?.sv_number || "") || !!t.err, JSON.stringify(t).slice(0, 120));
  await db.exec(patch);
  const def = (await db.query("SELECT pg_get_functiondef('create_service_case(uuid,integer,uuid,bigint,text,uuid,text,text,text,text,text,text,text,bigint,bigint)'::regprocedure) d")).rows[0].d;
  assert("128 on top of the first draft: no truncating lpad left, exactly one skip loop", !/lpad\(v_seq::text, 3, '0'\)/.test(def) && (def.match(/WHILE EXISTS/g) || []).length === 1);
  t = await tryCreate(db);
  assert("…and creates SV-1000", t.r?.sv_number === "SV-1000", JSON.stringify(t).slice(0, 160));

  console.log("\n── below 1000 / taken numbers ──");
  db = await mk(`INSERT INTO orders (id, company_id, so_number, sv_number, type, status) VALUES
    (1, '${A}', 'SV-005', 'SV-005', 'Service', 'Pending'), (2, '${A}', 'SV-006', NULL, 'Service', 'Pending');`);
  await db.exec(patch);
  t = await tryCreate(db);
  assert("small numbers keep 3-digit padding, and a number already used in the company is skipped (SV-006 taken → SV-007)", t.r?.sv_number === "SV-007", JSON.stringify(t).slice(0, 160));

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed  (real PostgreSQL via PGlite)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
