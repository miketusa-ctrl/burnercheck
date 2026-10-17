// Global daily soft cap (shared notes, scout-launch-2026-10-03b "Request budget guard"), same design as
// DnsGuard's budget.js: a cost backstop so BurnerCheck stays inside its share of the account's Workers
// Paid allowance however many IPs or keys show up.
//   checks: all checks (anonymous + keyed; a batch counts each address), capped at limits.checksPerDay
//   anon:   the anonymous share of that, capped at limits.anonPerDay (the rest is kept for key holders)
// APPROXIMATE on purpose: each isolate batches increments and flushes them to ONE KeyQuota DO instance
// (BUDGET_DO_NAME) every FLUSH_EVERY_N checks or FLUSH_EVERY_MS, so the pool costs ~1 DO request per 25
// checks. Overshoot is bounded by (active isolates × FLUSH_EVERY_N). DO unreachable → fail open (the
// per-minute limiters and per-key monthly quota still apply). Nothing identifying is sent or stored.
import { utcDay, POOL_FIELDS } from './quota.js';

export const BUDGET_DO_NAME = 'global:budget';
export const FLUSH_EVERY_N = 25;
export const FLUSH_EVERY_MS = 60_000;

const zero = () => Object.fromEntries(POOL_FIELDS.map((f) => [f, 0]));
const state = { day: null, seen: zero(), pending: zero(), lastFlush: 0, inflight: null };

export function resetBudgetState() {
  Object.assign(state, { day: null, seen: zero(), pending: zero(), lastFlush: 0, inflight: null });
}
export function budgetSnapshot() { return { day: state.day, seen: { ...state.seen }, pending: { ...state.pending } }; }

function roll(day) {
  if (state.day !== day) Object.assign(state, { day, seen: zero(), pending: zero(), lastFlush: 0 });
}
const used = (f) => state.seen[f] + state.pending[f];

export function secondsToUtcMidnight(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** Room for n more checks today? kind: 'anon' | 'key'. */
export function budgetAllows(kind, limits, n = 1, now = new Date()) {
  roll(utcDay(now));
  if (used('checks') + n > limits.checksPerDay) return { ok: false, pool: 'checks' };
  if (kind === 'anon' && used('anon') + n > limits.anonPerDay) return { ok: false, pool: 'anon' };
  return { ok: true };
}

/** Count n checks and flush the batch to the budget DO when due (in ctx.waitUntil when available). */
export function budgetRecord(kind, ns, ctx, n = 1, now = new Date()) {
  roll(utcDay(now));
  state.pending.checks += n;
  if (kind === 'anon') state.pending.anon += n;
  const due = state.pending.checks >= FLUSH_EVERY_N || state.pending.requests >= FLUSH_EVERY_N || now.getTime() - state.lastFlush >= FLUSH_EVERY_MS;
  if (!ns || !due || state.inflight) return null;
  const p = flushBudget(ns, now);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
  return p;
}

/** v0.2.2: count one HTTP request toward today's total (an integer only; nothing about the request is kept).
 * Rides the same batched flush as the check pool (~1 DO request per 25 requests). Never throws, never blocks. */
export function recordRequest(ns, ctx, now = new Date()) {
  try {
    roll(utcDay(now));
    state.pending.requests += 1;
    const due = state.pending.requests >= FLUSH_EVERY_N || now.getTime() - state.lastFlush >= FLUSH_EVERY_MS;
    if (!ns || !due || state.inflight) return null;
    const p = flushBudget(ns, now);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
    return p;
  } catch { return null; }
}

export async function flushBudget(ns, now = new Date()) {
  const day = utcDay(now);
  roll(day);
  const batch = { ...state.pending };
  state.pending = zero();
  state.lastFlush = now.getTime();
  const qs = POOL_FIELDS.map((f) => `${f}=${batch[f]}`).join('&');
  const p = (async () => {
    try {
      const stub = ns.get(ns.idFromName(BUDGET_DO_NAME));
      const res = await stub.fetch(`https://quota/add?day=${day}&${qs}`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const t = await res.json();
      if (state.day === day) for (const f of POOL_FIELDS) state.seen[f] = Math.max(state.seen[f], Number(t[f]) || 0);
      return t;
    } catch {
      if (state.day === day) for (const f of POOL_FIELDS) state.pending[f] += batch[f];
      return null;
    }
  })();
  state.inflight = p;
  p.finally(() => { if (state.inflight === p) state.inflight = null; });
  return p;
}
