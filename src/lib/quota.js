// Usage counters in a SQLite-backed Durable Object — the DnsGuard QUOTA pattern (dnsguard/src/lib/quota.js),
// adapted from a daily to a MONTHLY per-key quota (UTC calendar month) and n-at-a-time consumption for batch.
// - Per API key: one instance per key id (idFromName(`key:<keyId>`)), POST /consume — exact (DO input gates
//   serialize get→put). Denied requests write nothing.
// - Shared daily pool: ONE instance named BUDGET_DO_NAME (budget.js), POST /add with batched increments.
// Plain fetch()-style class (no `cloudflare:workers` import) so it is unit-testable in Node.
// Stored per instance: counters only ("m:<YYYY-MM>" = used, "d:<YYYY-MM-DD>:<pool>" = pool total). No emails,
// no domains, no IPs.

export const POOL_FIELDS = ['checks', 'anon', 'requests'];
// 'requests': total HTTP requests per UTC day, a bare integer. No IP, address, domain, user agent, path or any
// other identifier is part of the key or value. Kept REQUESTS_KEEP_DAYS for weekly reports.
export const REQUESTS_KEEP_DAYS = 35;

export function utcDay(now = new Date()) { return now.toISOString().slice(0, 10); }
export function utcMonth(now = new Date()) { return now.toISOString().slice(0, 7); }

/** First instant (ms) of the UTC month `months` after the month of `period` ("YYYY-MM"). */
export function monthStartAfter(period, months = 1) {
  const [y, m] = period.split('-').map(Number);
  return Date.UTC(y, m - 1 + months, 1);
}

export class KeyQuota {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.clock = () => Date.now(); // overridable in tests
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/add') {
      const day = url.searchParams.get('day') || utcDay();
      if (request.method !== 'POST' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return Response.json({ error: 'bad_request' }, { status: 400 });
      const inc = {};
      for (const f of POOL_FIELDS) {
        const n = Number(url.searchParams.get(f) || 0);
        if (!Number.isInteger(n) || n < 0 || n > 1_000_000) return Response.json({ error: 'bad_request' }, { status: 400 });
        inc[f] = n;
      }
      return Response.json(await this.add(day, inc));
    }
    if (url.pathname === '/requests') {
      // Read-only: last 7 UTC days of the daily request total (GET /v1/stats, token-gated).
      const out = {};
      const base = new Date(this.clock());
      for (let i = 0; i < 7; i++) {
        const d = utcDay(new Date(base.getTime() - i * 86400_000));
        out[d] = (await this.storage.get(`d:${d}:requests`)) || 0;
      }
      return Response.json({ requests_per_utc_day: out });
    }
    const period = url.searchParams.get('period') || utcMonth();
    const limit = Number(url.searchParams.get('limit') || 0);
    const n = Number(url.searchParams.get('n') || 1);
    if (!/^\d{4}-\d{2}$/.test(period) || !Number.isInteger(limit) || limit < 1 || !Number.isInteger(n) || n < 1 || n > 1000) {
      return Response.json({ error: 'bad_request' }, { status: 400 });
    }
    if (url.pathname === '/peek') {
      const used = (await this.storage.get(`m:${period}`)) || 0;
      return Response.json({ ok: used < limit, used, limit, period });
    }
    if (url.pathname !== '/consume' || request.method !== 'POST') return Response.json({ error: 'not_found' }, { status: 404 });
    return Response.json(await this.consume(period, limit, n));
  }

  /** All-or-nothing: consume n units if they fit under limit for the period. */
  async consume(period, limit, n = 1) {
    const key = `m:${period}`;
    const used = (await this.storage.get(key)) || 0;
    if (used + n > limit) return { ok: false, used, limit, period, requested: n };
    await this.storage.put(key, used + n);
    if (used === 0) await this.ensureCleanup(monthStartAfter(period, 2)); // keep this month + next, then delete
    return { ok: true, used: used + n, limit, period };
  }

  async add(day, inc) {
    const totals = { day };
    let first = false;
    for (const f of POOL_FIELDS) {
      const key = `d:${day}:${f}`;
      const cur = (await this.storage.get(key)) || 0;
      if (inc[f] > 0) {
        if (cur === 0) first = true;
        await this.storage.put(key, cur + inc[f]);
      }
      totals[f] = cur + inc[f];
    }
    if (first) await this.ensureCleanup(Date.parse(`${day}T00:00:00Z`) + 2 * 86400_000);
    return totals;
  }

  // Keep the EARLIEST pending alarm.
  async ensureCleanup(at) {
    const cur = await this.storage.getAlarm();
    if (!cur || cur > at) await this.storage.setAlarm(at);
  }

  // Delete monthly counters older than last month and daily pool counters older than yesterday,
  // then re-arm for the next 00:00 UTC while anything remains.
  async alarm() {
    const now = new Date(this.clock());
    const keepMonth = utcMonth(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
    const keepDay = utcDay(new Date(now.getTime() - 86400_000));
    const all = await this.storage.list({ prefix: '' });
    const keepReqDay = utcDay(new Date(now.getTime() - REQUESTS_KEEP_DAYS * 86400_000));
    const old = [...all.keys()].filter((k) => (k.startsWith('m:') && k.slice(2, 9) < keepMonth)
      || (k.startsWith('d:') && !k.endsWith(':requests') && k.slice(2, 12) < keepDay)
      || (k.startsWith('d:') && k.endsWith(':requests') && k.slice(2, 12) < keepReqDay));
    if (old.length) await this.storage.delete(old);
    if (all.size > old.length) {
      await this.storage.setAlarm(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    }
  }
}

export class QuotaUnavailable extends Error {
  constructor(message) { super(message); this.code = 'quota_unavailable'; }
}

// Per-isolate memo of keys already at their monthly cap ("quotaId|limit" → period): further single checks in
// this isolate get the 429 without another billed DO request.
const exhausted = new Map();
export function clearQuotaMemo() { exhausted.clear(); }

/** Consume n checks from the key's monthly quota. Throws QuotaUnavailable if the DO can't be reached. */
export async function consumeMonthlyQuota(ns, quotaId, limit, n = 1, now = new Date()) {
  if (!ns) throw new QuotaUnavailable('QUOTA binding missing');
  const period = utcMonth(now);
  const memoKey = `${quotaId}|${limit}`;
  if (exhausted.get(memoKey) === period) return { ok: false, used: limit, limit, period, memo: true };
  let out;
  try {
    const stub = ns.get(ns.idFromName(quotaId));
    const res = await stub.fetch(`https://quota/consume?period=${period}&limit=${limit}&n=${n}`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    out = await res.json();
  } catch (e) {
    throw new QuotaUnavailable(`quota counter unavailable: ${e.message}`);
  }
  if (out && out.ok === false && out.used >= limit) {
    exhausted.set(memoKey, period);
    if (exhausted.size > 5000) exhausted.delete(exhausted.keys().next().value);
  }
  return out;
}
