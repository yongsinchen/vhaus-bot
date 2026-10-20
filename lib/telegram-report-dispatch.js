// Durable, once-per-company-per-day delivery of a Telegram report (TG-02), over the dispatch ledger of
// migration 121 (telegram_report_dispatches + tg_report_* functions — read its header for the states).
//
// Guarantees:
//   * at most one logical report per (company, report type, report date): a 'sent' row is never sent
//     again, and concurrent / overlapping runs see 'busy' while another worker holds the lease;
//   * a report is 'sent' only after Telegram returned a message_id for its LAST part;
//   * a part Telegram definitely refused is retried (in this run, then by later runs), resuming after
//     the last confirmed part with the SAME frozen text;
//   * a part whose outcome is unknown (timeout, dropped connection, 5xx, or a worker that died while
//     sending) is never resent automatically — the row is 'uncertain' until an operator resolves it.
//     Telegram's Bot API has no idempotency key, so this is at-most-once for that one part, not
//     exactly-once.

function createReportDispatchStore({ supabase }) {
  const call = async (fn, args) => {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw new Error(`${fn} failed: ${error.message}`);
    return data;
  };
  return {
    claim: (companyId, reportType, reportDate, { leaseSeconds, maxAttempts }) =>
      call("tg_report_claim", { p_company_id: companyId, p_report_type: reportType, p_report_date: reportDate, p_lease_seconds: leaseSeconds, p_max_attempts: maxAttempts }),
    freezeParts: (dispatchId, token, chatId, parts) =>
      call("tg_report_freeze_parts", { p_dispatch_id: dispatchId, p_claim_token: token, p_chat_id: chatId, p_parts: parts }),
    beginPart: (dispatchId, token, part, leaseSeconds) =>
      call("tg_report_begin_part", { p_dispatch_id: dispatchId, p_claim_token: token, p_part: part, p_lease_seconds: leaseSeconds }),
    partSent: (dispatchId, token, part, messageId) =>
      call("tg_report_part_sent", { p_dispatch_id: dispatchId, p_claim_token: token, p_part: part, p_message_id: messageId }),
    fail: (dispatchId, token, outcome, error) =>
      call("tg_report_fail", { p_dispatch_id: dispatchId, p_claim_token: token, p_outcome: outcome, p_error: error }),
    resolve: (dispatchId, resolution, note) =>
      call("tg_report_resolve", { p_dispatch_id: dispatchId, p_resolution: resolution, p_note: note }),
  };
}

const defaultSleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Deliver one company's report for one date.
 * @param renderParts async () => string[] — called only when nothing of this report has been sent yet
 *                    (a resumed report finishes its frozen parts instead of re-rendering).
 * @param send        async (chatId, text) => { message_id } — throws an error with `.outcome`
 *                    "failed" (definitely not delivered) or anything else (treated as uncertain).
 * @returns {{ outcome: "sent"|"already_sent"|"busy"|"uncertain"|"gave_up"|"failed"|"lost_claim", dispatch_id?, attempt?, parts_total?, parts_sent?, error? }}
 */
async function deliverReport({ store, send, companyId, reportType, reportDate, chatId, renderParts,
  leaseSeconds = 300, maxAttempts = 5, sendRetries = 2, maxRetryAfterSeconds = 30, sleep = defaultSleep }) {
  const claim = await store.claim(companyId, reportType, reportDate, { leaseSeconds, maxAttempts });
  if (claim.outcome !== "claimed") return { outcome: claim.outcome, dispatch_id: claim.dispatch_id, parts_sent: claim.parts_sent, error: claim.last_error };
  const id = claim.dispatch_id, token = claim.claim_token;
  const base = { dispatch_id: id, attempt: claim.attempt };

  let parts = null;
  if (!(claim.parts_sent > 0)) {
    try { parts = await renderParts(); }
    catch (e) {
      await store.fail(id, token, "failed", `report build failed: ${e.message}`);
      return { ...base, outcome: "failed", parts_sent: 0, error: `report build failed: ${e.message}` };
    }
  }
  const frozen = await store.freezeParts(id, token, chatId, parts);
  if (!frozen.ok) return { ...base, outcome: "lost_claim" };
  const all = frozen.parts;
  const result = { ...base, parts_total: all.length, parts_sent: frozen.parts_sent, resumed: !!frozen.resumed };

  for (let k = frozen.parts_sent + 1; k <= all.length; k++) {
    const begun = await store.beginPart(id, token, k, leaseSeconds);
    if (!begun.ok) return { ...result, outcome: "lost_claim" };

    let sent = null;
    for (let retry = 0; ; retry++) {
      try { sent = await send(frozen.chat_id, all[k - 1]); break; }
      catch (e) {
        const definite = e?.outcome === "failed";
        const wait = e?.retryAfter != null ? e.retryAfter : 2 ** retry;
        if (definite && retry < sendRetries && wait <= maxRetryAfterSeconds) { await sleep(wait * 1000); continue; }
        const outcome = definite ? "failed" : "uncertain";
        const error = `part ${k}/${all.length}: ${e?.message || "send error"}`;
        await store.fail(id, token, outcome, error);
        return { ...result, outcome, error };
      }
    }

    const recorded = await store.partSent(id, token, k, sent.message_id);
    // Telegram has the part; only the ledger write was refused (claim taken over). The row is then
    // 'uncertain' with this part in flight — never resent automatically.
    if (!recorded.ok) return { ...result, parts_sent: k - 1, outcome: "lost_claim", error: `part ${k} delivered but not recorded` };
    result.parts_sent = k;
  }
  return { ...result, outcome: "sent" };
}

module.exports = { createReportDispatchStore, deliverReport };
