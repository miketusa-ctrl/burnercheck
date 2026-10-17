// "Did you mean" for common webmail typos (gamil.com → gmail.com). Pure string math, no lookups. v0.1.1 rules,
// deliberately conservative — a wrong "correction" tells a real user their address is wrong:
//   - never suggest for a domain that is already on any list: disposable, free provider or allowlist;
//   - only edit distance 1 (one insert/delete/substitute/adjacent swap);
//   - never change the country/registry ending (hotmail.ca stays, yahoo.co.nz stays, gmail.co stays). The only
//     ending fixes are for endings that don't exist as TLDs (.con/.cpm/.ocm… → .com, .ent/.nte… → .net).
import { SUGGEST_TARGETS } from './curated.js';
import { isDisposable, isAllowlisted, isFreeProvider } from './lists.js';

// Typos of "com"/"net" that are NOT real TLDs (co, cm, om, bet were removed in v0.1.1: they are real endings).
export const COM_TYPOS = new Set(['con', 'cpm', 'vom', 'xom', 'comm', 'cim', 'ocm', 'cmo', 'coom', 'clm', 'c0m', 'cmm', 'ccom']);
export const NET_TYPOS = new Set(['ent', 'nte', 'ner', 'met', 'nett', 'nt', 'nwt', 'bet0']);
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'ac', 'gov', 'edu', 'ne', 'or', 'ltd', 'plc', 'gen', 'nom']);

/** Registry ending: "com", "ca", "co.uk", "com.au", "co.nz" … */
export function endingOf(domain) {
  const p = domain.split('.');
  const tld = p[p.length - 1];
  if (p.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(p[p.length - 2])) return `${p[p.length - 2]}.${tld}`;
  return tld;
}

/** Optimal-string-alignment distance (Levenshtein + adjacent transposition), early exit above `max`. */
export function editDistance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    prev = cur;
  }
  return prev[b.length];
}

/** True if the domain is on any list we ship (then it is never "corrected"). */
export function onAnyList(domain) {
  return isFreeProvider(domain) || isAllowlisted(domain) || isDisposable(domain);
}

/** Suggested domain, or null. Ambiguous (two targets at distance 1) → null. */
export function suggestDomain(domain) {
  if (!domain || domain.length > 64 || onAnyList(domain)) return null;
  const hasDot = domain.includes('.');
  const end = hasDot ? endingOf(domain) : null;
  const dot = domain.lastIndexOf('.');
  const name = hasDot ? domain.slice(0, dot) : domain;
  const tld = hasDot ? domain.slice(dot + 1) : '';
  const hits = new Set();
  for (const t of SUGGEST_TARGETS) {
    if (editDistance(domain, t, 1) !== 1) continue;
    const tEnd = endingOf(t);
    if (!hasDot) {
      if (domain === t.replace('.', '')) hits.add(t); // "gmailcom" → missing dot only
    } else if (tEnd === end) {
      if (t.length >= 9) hits.add(t); // name typo, same ending; short names (aol.com, me.com) too risky
    } else {
      const td = t.lastIndexOf('.');
      const want = t.slice(td + 1);
      const fixable = (want === 'com' && COM_TYPOS.has(tld)) || (want === 'net' && NET_TYPOS.has(tld));
      if (fixable && t.slice(0, td) === name) hits.add(t); // ending typo that isn't a real TLD
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}
