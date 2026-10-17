// Disposable / allowlist / role / free-provider lookups.
// The blocklist is ONE sorted newline-joined string; lookups binary-search it in place, so a cold isolate
// does no Set construction over ~9k+ entries (low start-up CPU). The allowlist is small (~200), a Set is fine.
import { BLOCKLIST, ALLOWLIST, LIST_META } from '../data/list.js';
import { ROLE_LOCALS, FREE_PROVIDERS } from './curated.js';

export { LIST_META };

/** Binary search for an exact line in a sorted, newline-joined string (no trailing newline required). */
export function sortedHas(blob, needle) {
  if (!needle) return false;
  let lo = 0;
  let hi = blob.length; // invariant: lo and hi are line starts (or blob.length)
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const s = blob.lastIndexOf('\n', mid - 1) + 1; // start of the line containing mid
    let e = blob.indexOf('\n', s);
    if (e === -1) e = blob.length;
    const line = blob.slice(s, e);
    if (line === needle) return true;
    if (line < needle) lo = e + 1;
    else hi = s;
  }
  return false;
}

const allowSet = new Set(ALLOWLIST);

/**
 * The domain and EVERY parent down to the 2-label suffix (a.b.c.com → a.b.c.com, b.c.com, c.com). v0.1.1: no
 * cap. v0.1.0 kept the 16 leftmost suffixes, so a 20-label subdomain of a listed domain skipped the listed
 * parent. A domain is at most 253 chars (≤127 labels), so this is ≤126 binary searches.
 */
export function suffixes(domain) {
  const parts = domain.split('.');
  const out = [];
  for (let i = parts.length - 2; i >= 0; i--) out.push(parts.slice(i).join('.'));
  return out;
}

export function isAllowlisted(domain, allow = allowSet) {
  if (!domain) return false;
  return suffixes(domain).some((d) => allow.has(d));
}

/** Disposable if the domain or a parent is on the blocklist, unless the domain or a parent is allowlisted. */
export function isDisposable(domain, { blob = BLOCKLIST, allow = allowSet } = {}) {
  if (!domain) return false;
  if (isAllowlisted(domain, allow)) return false;
  return suffixes(domain).some((d) => sortedHas(blob, d));
}

/** Role address: local part (lowercased, "+tag" removed) is on the curated role list. */
export function isRole(local) {
  if (!local) return false;
  const base = String(local).toLowerCase().split('+')[0];
  return ROLE_LOCALS.has(base);
}

export function isFreeProvider(domain) {
  return Boolean(domain) && FREE_PROVIDERS.has(domain);
}
