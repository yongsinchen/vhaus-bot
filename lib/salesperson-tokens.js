// ── Salesperson tokens: the ONE parser for orders.salesman ──────────────────
// orders.salesman holds one or more salesperson names separated by "/"
// ("Jim", "Gabby / Wayne", "Gabby/ Wayne / Loo"). Commission payee resolution
// and the monthly tier total must read it the same way:
//   split on "/", trim each part, drop empties → tokens
//   a name matches a token by case-insensitive EXACT equality.
// Therefore "Jim" ≠ "Jimmy" (either way), "Gabby / Wayne" is Gabby + Wayne,
// "Jim / Jimmy" counts for both, and a malformed "GABBY WAYNE" is ONE token
// that matches neither. No substring, prefix or fuzzy matching.

function salespersonTokens(salesman) {
  return String(salesman == null ? "" : salesman).split("/").map(s => s.trim()).filter(Boolean);
}

function orderHasSalesperson(salesman, name) {
  const n = String(name == null ? "" : name).trim().toLowerCase();
  if (!n) return false;
  return salespersonTokens(salesman).some(t => t.toLowerCase() === n);
}

// Escape LIKE metacharacters so a server-side ILIKE pre-filter on a name is a
// literal substring match (still a guaranteed superset of exact-token matches).
function escapeLike(s) {
  return String(s == null ? "" : s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

module.exports = { salespersonTokens, orderHasSalesperson, escapeLike };
