// Lookalike (homoglyph) detection for internationalized domains. Domains are handled as punycode (xn--)
// internally; this decodes them back to Unicode (RFC 3492) and flags:
//   1) a label that mixes scripts (Latin + Cyrillic/Greek, or Cyrillic + Greek), e.g. "gmаil" with Cyrillic а;
//   2) a non-ASCII domain whose ASCII "skeleton" (common Cyrillic/Greek lookalikes mapped to Latin) is a known
//      free provider, suggestion target or disposable domain, e.g. an all-Cyrillic "раураl.com".
// Pure string work, no lookups.

const BASE = 36, TMIN = 1, TMAX = 26, SKEW = 38, DAMP = 700, INITIAL_BIAS = 72, INITIAL_N = 128;

function adapt(delta, numPoints, first) {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - TMIN) * TMAX) >> 1) { d = Math.floor(d / (BASE - TMIN)); k += BASE; }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + SKEW));
}
function digit(c) {
  if (c >= 48 && c <= 57) return c - 22; // 0-9 → 26-35
  if (c >= 97 && c <= 122) return c - 97; // a-z → 0-25
  if (c >= 65 && c <= 90) return c - 65;
  return BASE;
}

/** Decode one punycode label body (without "xn--"). Returns null if malformed. */
export function decodePunycode(input) {
  const out = [];
  const b = input.lastIndexOf('-');
  for (let j = 0; j < Math.max(b, 0); j++) {
    if (input.charCodeAt(j) >= 0x80) return null;
    out.push(input.charCodeAt(j));
  }
  let n = INITIAL_N, bias = INITIAL_BIAS, i = 0;
  for (let pos = b > 0 ? b + 1 : 0; pos < input.length;) {
    const oldi = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (pos >= input.length) return null;
      const d = digit(input.charCodeAt(pos++));
      if (d >= BASE) return null;
      i += d * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (d < t) break;
      w *= BASE - t;
      if (w > 0x7fffffff) return null;
    }
    bias = adapt(i - oldi, out.length + 1, oldi === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  return String.fromCodePoint(...out);
}

/** ASCII/punycode domain → Unicode form (labels that fail to decode are kept as-is). */
export function toUnicode(domain) {
  return String(domain || '').split('.').map((l) => {
    if (!l.startsWith('xn--')) return l;
    const u = decodePunycode(l.slice(4));
    return u == null ? l : u;
  }).join('.');
}

const LATIN = /\p{Script=Latin}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;
const GREEK = /\p{Script=Greek}/u;

// Common lookalikes → Latin (lowercase only; input is already lowercased).
const SKELETON = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'һ': 'h', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'ӏ': 'l', 'м': 'm', 'н': 'h',
  'о': 'o', 'р': 'p', 'с': 'c', 'ѕ': 's', 'т': 't', 'у': 'y', 'х': 'x', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w', 'ɡ': 'g', 'ս': 'u',
  'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x',
  'ϲ': 'c', 'ω': 'w', 'ı': 'i', 'ү': 'y',
};
// decompose first (NFD) and drop combining marks, so Latin-diacritic lookalikes such as gmáil / gmäil
// reduce to "gmail" (and Cyrillic й/ё/ї lose their marks before the table lookup).
export function skeleton(unicode) {
  let s = '';
  for (const ch of unicode.normalize('NFD').replace(/\p{M}/gu, '')) s += SKELETON[ch] || ch;
  return s;
}

function mixedScript(label) {
  let latin = false, cyr = false, greek = false;
  for (const ch of label) {
    if (/[0-9-]/.test(ch)) continue;
    if (LATIN.test(ch)) latin = true;
    else if (CYRILLIC.test(ch)) cyr = true;
    else if (GREEK.test(ch)) greek = true;
  }
  return (latin && (cyr || greek)) || (cyr && greek);
}

// Whole-script homograph. A label written ONLY with Cyrillic letters that look like lowercase Latin letters, as
// in Chrome's IDN spoof checker ([асԁеһіјӏорԛѕԝхуү]), under a Latin generic TLD (.com/.net/.org), e.g.
// "аррӏе.com" or "ѕсоре.net". Letters such as в к м н т look like small capitals, not Latin, so real words
// (москва.com, метро.com, кот.net) are not flagged. There is no all-Greek case: Greek look-alikes of KNOWN
// domains are still caught by the skeleton match in confusableInfo(). Known trade-off (same as Chrome): a real
// word made only of these letters (e.g. оса.com) is still flagged.
const LATIN_GTLDS = new Set(['com', 'net', 'org']);
const LATIN_LOOKING_CYRILLIC = /^[асԁеһіјӏорԛѕԝхуү0-9-]+$/u;
function wholeScriptHomograph(labels) {
  if (labels.length < 2 || !LATIN_GTLDS.has(labels[labels.length - 1])) return false;
  return labels.slice(0, -1).some((label) => /[^0-9-]/.test(label) && LATIN_LOOKING_CYRILLIC.test(label));
}

/**
 * @param {string} domain ASCII (punycode) domain
 * @param {(ascii:string)=>boolean} isKnown true if an ASCII domain is a provider/target/disposable we know
 * @returns {{confusable:boolean, lookalike:string|null}} lookalike = the ASCII domain it imitates, if known
 */
export function confusableInfo(domain, isKnown = () => false) {
  if (!domain || !domain.includes('xn--')) return { confusable: false, lookalike: null };
  const uni = toUnicode(domain);
  if (!/[^\x00-\x7f]/.test(uni)) return { confusable: false, lookalike: null };
  const skel = skeleton(uni);
  const asciiSkel = /^[\x00-\x7f]+$/.test(skel) ? skel : null;
  const known = asciiSkel && isKnown(asciiSkel) ? asciiSkel : null;
  const labels = uni.split('.');
  const mixed = labels.some(mixedScript);
  return { confusable: mixed || Boolean(known) || wholeScriptHomograph(labels), lookalike: known };
}
