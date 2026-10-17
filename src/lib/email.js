// Offline syntax checks. No DNS/MX lookups, no subrequests.

export const MAX_INPUT = 320; // longer input is rejected before any parsing
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const SAFE_IDN_RE = /^[^\s/?#:@[\]\\%<>"'`{}|^]+$/;

/** Lowercase, strip one trailing dot, convert Unicode (IDN) names to punycode. Returns '' if hopeless. */
export function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  if (d.endsWith('.')) d = d.slice(0, -1);
  if (!d) return '';
  if (/[^\x00-\x7f]/.test(d)) {
    if (!SAFE_IDN_RE.test(d)) return d;
    try { d = new URL(`http://${d}/`).hostname; } catch { return d; }
  }
  return d;
}

export function isValidDomain(d) {
  if (!d || d.length > 253) return false;
  const labels = d.split('.');
  if (labels.length < 2) return false;
  for (const l of labels) if (!LABEL_RE.test(l)) return false;
  return TLD_RE.test(labels[labels.length - 1]);
}

export function isValidLocal(local) {
  return typeof local === 'string' && local.length >= 1 && local.length <= 64 && LOCAL_RE.test(local);
}

/**
 * Split an address on the LAST "@". Returns { email, local, domain, valid_syntax }.
 * `email` is the trimmed input with the domain part normalized; it is returned to the caller only, never stored.
 */
export function parseEmail(input) {
  const raw = String(input ?? '').trim();
  const at = raw.lastIndexOf('@');
  if (at < 0) return { email: raw, local: null, domain: null, valid_syntax: false };
  const local = raw.slice(0, at);
  const domain = normalizeDomain(raw.slice(at + 1));
  const email = `${local}@${domain}`;
  const valid = isValidLocal(local) && isValidDomain(domain) && email.length <= 254;
  return { email, local, domain: domain || null, valid_syntax: valid };
}
