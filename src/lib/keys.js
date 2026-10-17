// API keys (Authorization: Bearer bc_live_<64 hex>). Only the SHA-256 hash is stored, in Workers KV:
//   key:<sha256 hex> → {"keyId","plan","label","createdAt","monthlyLimit"?}
// Keys are minted offline with scripts/mint-key.mjs (no self-serve signup or billing in v0.1).

export const KEY_PREFIX = 'bc_live_';
const KEY_BODY_RE = /^[a-f0-9]{64}$/;

/** Planned pricing (not for sale yet; no billing is wired up). Monthly = UTC calendar month. Keys are issued by request during early access. */
export const PLANS = {
  free: { monthly: 1000, batch: false, price_usd: 0 },
  pro: { monthly: 25000, batch: true, price_usd: 9 },
  business: { monthly: 250000, batch: true, price_usd: 29 },
};

export class StorageError extends Error {
  constructor(cause) { super(`KV get failed${cause && cause.message ? `: ${cause.message}` : ''}`); this.code = 'storage_unavailable'; }
}

export function generateApiKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return KEY_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function isKeyFormat(raw) {
  return typeof raw === 'string' && raw.startsWith(KEY_PREFIX) && KEY_BODY_RE.test(raw.slice(KEY_PREFIX.length));
}

export async function hashApiKey(raw) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Returns the raw key from `Authorization: Bearer …`, '' if the header is present but malformed, null if absent. */
export function extractApiKey(request) {
  const auth = request.headers.get('authorization');
  if (auth == null) return null;
  const m = auth.match(/^Bearer[ \t]+(\S+)[ \t]*$/i);
  return m ? m[1] : '';
}

const lookupCache = new Map();
const LOOKUP_TTL_MS = 60_000;
export function clearKeyLookupCache() { lookupCache.clear(); }

/** Look up a key record (read-only). null if malformed/unknown. Throws StorageError if KV fails. */
export async function lookupKey(kv, raw) {
  if (!kv || !isKeyFormat(raw)) return null;
  const hash = await hashApiKey(raw);
  const c = lookupCache.get(hash);
  if (c && Date.now() - c.t < LOOKUP_TTL_MS) return c.rec;
  let stored;
  try { stored = await kv.get(`key:${hash}`, 'json'); } catch (e) { throw new StorageError(e); }
  if (!stored || typeof stored !== 'object' || !PLANS[stored.plan]) {
    // Negative cache: an unknown key is not re-read from KV for 60 s in this isolate. Side effect: a
    // key minted within 60 s of a failed lookup of that same key works after the minute.
    lookupCache.set(hash, { t: Date.now(), rec: null });
    if (lookupCache.size > 2000) lookupCache.delete(lookupCache.keys().next().value);
    return null;
  }
  const plan = PLANS[stored.plan];
  const monthly = Number.isInteger(stored.monthlyLimit) && stored.monthlyLimit > 0 ? stored.monthlyLimit : plan.monthly;
  const rec = { keyId: stored.keyId || hash.slice(0, 16), plan: stored.plan, monthly, batch: plan.batch };
  lookupCache.set(hash, { t: Date.now(), rec });
  if (lookupCache.size > 2000) lookupCache.delete(lookupCache.keys().next().value);
  return rec;
}
