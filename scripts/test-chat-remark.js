#!/usr/bin/env node
/**
 * lib/chat-remark.js — the remark a salesman types with a delivery-date request in the web chat.
 * Usage: node scripts/test-chat-remark.js
 */
const { extractRemark, splitDateAndRemark, intentRemark, cleanRemark, MAX_REMARK } = require("../lib/chat-remark");
let pass = 0, fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (ok) { console.log(`  ✅ ${name}`); pass++; } else { console.log(`  ❌ ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); fail++; } };
const now = new Date("2026-10-22T04:00:00Z"); // Malaysia date 2026-10-22

console.log("\n══ extractRemark — explicit remarks only ══\n");
eq("comma (unchanged behaviour)", extractRemark("11741 move to sunday, customer very annoying"), "customer very annoying");
eq("semicolon", extractRemark("25/10; after 3pm"), "after 3pm");
eq("Chinese comma", extractRemark("25/10，客户要下午"), "客户要下午");
eq("new line", extractRemark("25/10\nhelp dispose 2pcs single mattress"), "help dispose 2pcs single mattress");
eq("remark: label (whole remark kept, even across lines)", extractRemark("81001 25/10 remark: after 3pm\nbig lorry"), "after 3pm\nbig lorry");
eq("note - label", extractRemark("move 81001 note - call before arriving"), "call before arriving");
eq("备注 label", extractRemark("25/10 备注：帮忙载走旧的餐桌"), "帮忙载走旧的餐桌");
eq("catatan label (Malay)", extractRemark("esok catatan: rumah tingkat 3"), "rumah tingkat 3");
eq("because", extractRemark("15/7 because customer is overseas"), "customer is overseas");
eq("sebab (Malay)", extractRemark("esok sebab customer urgent"), "customer urgent");
eq("因为 (Chinese)", extractRemark("25/10 因为客户出国"), "客户出国");
eq("no separator → nothing guessed", extractRemark("11778 25/10 customer prefer after 3pm"), null);
eq("plain date → none", extractRemark("25/10"), null);
eq("empty after a separator → none", extractRemark("25/10,  "), null);
eq("'notes' inside a word is not a label", extractRemark("keynotes:"), null);

console.log("\n══ splitDateAndRemark — the reply to 'When should it be delivered?' ══\n");
eq("date only", splitDateAndRemark("25/10", now), { date: "2026-10-25", remark: null });
eq("date, remark", splitDateAndRemark("25/10, after 3pm", now), { date: "2026-10-25", remark: "after 3pm" });
eq("date remark — no separator (used to fail: 'couldn't understand that date')", splitDateAndRemark("25/10 after 3pm", now), { date: "2026-10-25", remark: "after 3pm" });
eq("tmr + new line", splitDateAndRemark("tmr\nhelp dispose mattress", now), { date: "2026-10-23", remark: "help dispose mattress" });
eq("hari ini + sebab", splitDateAndRemark("hari ini sebab customer urgent", now), { date: "2026-10-22", remark: "customer urgent" });
eq("full date with year + remark", splitDateAndRemark("4/11/2026 SG arrange", now), { date: "2026-11-04", remark: "SG arrange" });
eq("TBC alone", splitDateAndRemark("TBC", now), { date: "TBC", remark: null });
eq("not a date → nothing", splitDateAndRemark("customer prefer after 3pm", now), { date: null, remark: null });
eq("a weekday is not a date the parser knows (unchanged)", splitDateAndRemark("sunday, customer annoyed", now), { date: null, remark: null });

console.log("\n══ intentRemark — the AI parser's remark, never a made-up one ══\n");
eq("a real instruction is kept, in the user's words", intentRemark("customer prefer after 3pm", { soNumber: "11778" }), "customer prefer after 3pm");
eq("Chinese kept", intentRemark("帮忙载走旧的餐桌 不需要charge"), "帮忙载走旧的餐桌 不需要charge");
eq("only the SO number + date + verb → dropped", intentRemark("move 11778 to 25/10", { soNumber: "11778" }), null);
eq("only a verb → dropped", intentRemark("reschedule please"), null);
eq("only a relative date → dropped", intentRemark("next friday"), null);
eq("non-string → dropped", intentRemark(42), null);
eq("blank → dropped", intentRemark("   "), null);

console.log("\n══ cleanRemark ══\n");
eq("leading separators trimmed", cleanRemark(" , ; after 3pm  "), "after 3pm");
eq(`capped at ${MAX_REMARK} characters`, cleanRemark("x".repeat(900)).length, MAX_REMARK);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
