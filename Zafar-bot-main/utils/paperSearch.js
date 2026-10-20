/** Deterministic typo suggestions for course/module identifiers in the paper vault. */

/** Bounded Levenshtein (these are short codes, so no fancy optimisation needed). */
function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length];
}

/**
 * "Did you mean" for a code the vault does not have.
 * @param {string} code     what was asked for, e.g. "NURS"
 * @param {string|null} module  e.g. "2210" (optional)
 * @param {Array<{code:string, module?:string, count?:number, years?:string[]}>} entries
 *        every (code, module) pair that actually exists, already tallied
 * @returns {Array<object>} up to `limit` candidates, best first, each with `score`
 */
function nearest(code, module, entries, { limit = 4 } = {}) {
  const wanted = String(code || '').toUpperCase().trim();
  if (wanted.length < 2 || !Array.isArray(entries)) return [];

  const scored = [];
  for (const e of entries) {
    const have = String(e.code || '').toUpperCase();
    if (!have) continue;
    const samePrefix = have.startsWith(wanted) || wanted.startsWith(have);
    const codeDistance = editDistance(wanted, have);
    if (codeDistance > 3 && !samePrefix) continue;

    const moduleDistance = module ? editDistance(String(module), String(e.module || '')) : 0;
    if (have === wanted && module && moduleDistance > 2) continue;

    // Code similarity matters most; a module typo is the weaker signal.
    const distance = codeDistance * 2 + moduleDistance - (have === wanted ? 1 : 0);
    scored.push({
      ...e,
      code: have,
      distance: Math.max(0, distance),
      score: Number(Math.max(0, 1 - Math.max(0, distance) / 8).toFixed(3)),
    });
  }
  return scored
    .sort((a, b) => a.distance - b.distance || (b.count || 0) - (a.count || 0))
    .slice(0, limit);
}


module.exports = { nearest, editDistance };
