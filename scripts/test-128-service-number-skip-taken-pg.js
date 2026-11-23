#!/usr/bin/env node
/**
 * Migration 128 — create_service_case() skips an SV number already used as an order number — REAL PostgreSQL (PGlite;
 * production never touched).
 *
 * Reproduces 2026-11-23: an orders row holds "SV-006" as its so_number with a blank sv_number, so MAX(sv_number)+1 =
 * SV-006 every time → "orders_so_number_company_unique" on every New Service Case. Then applies migration 128 (the
 * in-place patch) and checks the next case gets the next FREE number, numbering continues, the patch is refused on a
 * second run, SECURITY DEFINER is kept, and the diagnostic query names the blocking row.
 *
 * Usage: node scripts/test-128-service-number-skip-taken-pg.js
 */
const fs = require("fs");
const path = require("path");
const { createTestDb, loadFunctions, REPO } = require("./pg/pglite-db");
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002", U = "00000000-0000-4000-8000-000000000011";

(async () => {
  const db = await createTestDb();
  await loadFunctions(db, "069_service_type_delivery_plain.sql");
  await db.exec(`CREATE SEQUENCE orders_id_seq START 100; ALTER TABLE orders ALTER COLUMN id SET DEFAULT nextval('orders_id_seq');
    ALTER TABLE services ALTER COLUMN id SET DEFAULT gen_random_uuid(); ALTER TABLE service_legs ALTER COLUMN id SET DEFAULT gen_random_uuid();
    CREATE UNIQUE INDEX orders_so_number_company_unique ON orders (company_id, so_number);
    INSERT INTO companies (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
    INSERT INTO orders (id, company_id, so_number, sv_number, type, status) VALUES
      (1, '${A}', 'SV-005', 'SV-005', 'Service', 'Pending'),
      (2, '${A}', 'SV-006', NULL, 'Service', 'Pending'),
      (3, '${A}', 'SV-007', NULL, 'Service', 'Pending'),
      (4, '${B}', 'SV-010', NULL, 'Service', 'Pending');   -- company B holds SV-010 the same way`);
  const create = (co = A) => db.query(`SELECT create_service_case($1::uuid, 1, $2::uuid, NULL, 'test', NULL, 'Cust', '0123', 'Addr') r`, [co, U]);
  const diag = fs.readFileSync(path.join(REPO, "scripts", "sql", "128_diagnose_service_number.sql"), "utf8");
  const patch = fs.readFileSync(path.join(REPO, "migrations", "128_service_number_skip_taken.sql"), "utf8");

  const d = (await db.query(diag)).rows;
  assert("diagnostic names the next number and the row blocking it", d.length === 1 && d[0].next_sv_number === "SV-006" && d[0].so_number === "SV-006" && d[0].sv_number === null && d[0].company === "A", JSON.stringify(d));
  let err = null; try { await create(); } catch (e) { err = e.message; }
  assert("before 128: New Service Case fails exactly like production", /orders_so_number_company_unique/.test(err || ""), err);

  await db.exec(patch);
  let r = (await create()).rows[0].r;
  assert("after 128: the case is created with the next FREE number (SV-006, SV-007 taken → SV-008)", r.sv_number === "SV-008", JSON.stringify(r).slice(0, 200));
  assert("…its order row carries that number as so_number and sv_number", (await db.query("SELECT sv_number FROM orders WHERE company_id = $1 AND so_number = 'SV-008'", [A])).rows[0]?.sv_number === "SV-008");
  r = (await create()).rows[0].r;
  assert("numbering continues normally (SV-009)", r.sv_number === "SV-009");
  r = (await create(B)).rows[0].r;
  assert("company B: the next number SV-010 is taken in B → B gets SV-011 (the running number is shared; the skip is per company)", r.sv_number === "SV-011", r.sv_number);
  assert("…and never clashes in company B", (await db.query("SELECT count(*) c FROM orders WHERE company_id = $1 AND so_number = $2", [B, r.sv_number])).rows[0].c == 1);
  err = null; try { await db.exec(patch); } catch (e) { err = e.message; }
  assert("running 128 twice is refused harmlessly", /already applied/.test(err || ""), err);
  assert("SECURITY DEFINER kept", (await db.query("SELECT prosecdef FROM pg_proc WHERE proname = 'create_service_case'")).rows[0].prosecdef === true);

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed  (real PostgreSQL via PGlite)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
