// The check itself: pure, offline, a few microseconds. No DNS/MX, no subrequests, no storage.
import { parseEmail, normalizeDomain, isValidDomain } from './email.js';
import { isDisposable, isRole, isFreeProvider, LIST_META } from './lists.js';
import { suggestDomain } from './suggest.js';
import { confusableInfo } from './idn.js';
import { SUGGEST_TARGETS, FREE_PROVIDERS } from './curated.js';

const knownForLookalike = (d) => FREE_PROVIDERS.has(d) || SUGGEST_TARGETS.includes(d) || isDisposable(d);

/** Suggestion + lookalike flag for a normalized domain. A lookalike of a big provider suggests the real one. */
function domainSignals(domain) {
  const c = confusableInfo(domain, knownForLookalike);
  let sugg = suggestDomain(domain);
  if (!sugg && c.lookalike && FREE_PROVIDERS.has(c.lookalike)) sugg = c.lookalike;
  return { confusable: c.confusable, sugg };
}

export function checkEmail(input) {
  const p = parseEmail(input);
  const domain = p.domain;
  const s = domain ? domainSignals(domain) : { confusable: false, sugg: null };
  return {
    email: p.email,
    domain,
    valid_syntax: p.valid_syntax,
    disposable: domain ? isDisposable(domain) : false,
    role: p.local != null && isRole(p.local),
    free_provider: isFreeProvider(domain),
    suggestion: s.sugg && p.local != null ? `${p.local}@${s.sugg}` : null,
    confusable: s.confusable,
    list_version: LIST_META.list_version,
  };
}

/** Domain-only check: never takes or returns a local part. */
export function checkDomain(input) {
  const domain = normalizeDomain(input);
  const s = domain ? domainSignals(domain) : { confusable: false, sugg: null };
  return {
    domain: domain || null,
    valid_syntax: isValidDomain(domain),
    disposable: domain ? isDisposable(domain) : false,
    free_provider: isFreeProvider(domain),
    suggestion: s.sugg,
    confusable: s.confusable,
    list_version: LIST_META.list_version,
  };
}

/** One-word verdict for the web page: invalid | disposable | confusable | role | free | unlisted. */
export function verdict(r) {
  if (!r.valid_syntax) return 'invalid';
  if (r.disposable) return 'disposable';
  if (r.confusable) return 'confusable';
  if (r.role) return 'role';
  if (r.free_provider) return 'free';
  return 'unlisted';
}
