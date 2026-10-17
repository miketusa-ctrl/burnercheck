// Request router. Kept free of Worker-only imports so it can be unit-tested in Node (node --test).
import { checkEmail, checkDomain, verdict } from './lib/check.js';
import { MAX_INPUT } from './lib/email.js';
import { LIST_META } from './lib/lists.js';
import { extractApiKey, lookupKey, StorageError, PLANS } from './lib/keys.js';
import { consumeMonthlyQuota, QuotaUnavailable, monthStartAfter, utcMonth } from './lib/quota.js';
import { budgetAllows, budgetRecord, recordRequest, BUDGET_DO_NAME, secondsToUtcMidnight } from './lib/budget.js';
import { VERSION } from './lib/version.js';
import { handleMcp } from './lib/mcp.js';
import { llmsTxt, openApiSpec, serverCard, glamaJson } from './lib/agentdocs.js';

export { VERSION };
export const MAX_BODY_BYTES = 16 * 1024; // POST body cap (100 emails × ~100 bytes ≈ 10 KB)
export const MAX_BATCH = 100;
export const CONTACT = 'digitalpromohub.support+burnercheck@gmail.com';

// Defaults match wrangler.toml [vars]; per-minute numbers must also match the ratelimit bindings' simple.limit.
export const DEFAULT_LIMITS = {
  anonPerMin: 10, // ANON_CHECKS_PER_MIN / CHECK_LIMITER (per IP)
  keyPerMin: 120, // KEY_CHECKS_PER_MIN / KEY_LIMITER (per API key; a batch call counts as 1 request)
  checksPerDay: 12000, // DAILY_CHECK_POOL: all checks, all users (approximate; budget.js)
  anonPerDay: 7000, // DAILY_ANON_CHECK_POOL: anonymous share; the rest is kept for key holders
};
function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : d; }
export function limitsFor(env = {}) {
  const L = DEFAULT_LIMITS;
  return {
    anonPerMin: num(env.ANON_CHECKS_PER_MIN, L.anonPerMin),
    keyPerMin: num(env.KEY_CHECKS_PER_MIN, L.keyPerMin),
    checksPerDay: num(env.DAILY_CHECK_POOL, L.checksPerDay),
    anonPerDay: num(env.DAILY_ANON_CHECK_POOL, L.anonPerDay),
  };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-expose-headers': 'x-quota-limit, x-quota-remaining, x-quota-reset, retry-after',
  'access-control-max-age': '86400',
};
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains', // v0.1.1
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const AGENT_X = { batchMax: MAX_BATCH, restBodyBytes: MAX_BODY_BYTES, maxInput: MAX_INPUT, plans: PLANS };
const isStaging = (env) => String(env.PUBLIC_LAUNCH || 'false') !== 'true';

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...SECURITY, ...extra },
  });
}
const apiError = (status, code, message, extra) => json({ error: { code, message } }, status, extra);

// Per-isolate fallback limiter (used only when a ratelimit binding is missing, e.g. tests / local dev).
const memLimits = new Map();
function memLimit(key, limit, periodMs = 60_000) {
  const now = Date.now();
  const e = memLimits.get(key);
  if (!e || now - e.start > periodMs) { memLimits.set(key, { start: now, n: 1 }); if (memLimits.size > 5000) memLimits.clear(); return true; }
  e.n++;
  return e.n <= limit;
}
export function clearMemLimits() { memLimits.clear(); }

// Anonymous limiter key: IPv4 as is, IPv6 -> its /64 (v0.2.0, recipe r2 §1; same output as phonecheck/workdayapi/certguard).
export function ipBucket(ip) {
  const s = String(ip || 'unknown').trim().toLowerCase();
  if (!s.includes(':')) return s;
  if (s.includes('.')) return s.slice(s.lastIndexOf(':') + 1);
  const [h, t] = s.split('::'), head = h ? h.split(':') : [], tail = t ? t.split(':') : [];
  const parts = t === undefined ? head : [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  return parts.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '') || '0').join(':') + '::/64';
}
const clientIp = (request) => ipBucket(request.headers.get('cf-connecting-ip') || 'unknown');

async function limited(binding, key, limit) {
  if (binding && typeof binding.limit === 'function') {
    try { const { success } = await binding.limit({ key }); return !success; } catch { /* fall back */ }
  }
  return !memLimit(key, limit);
}

class BodyTooLarge extends Error {}

/** Read at most `cap` bytes of the body; throws BodyTooLarge as soon as the real byte count passes the cap. */
async function readCapped(request, cap) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { try { await reader.cancel(); } catch { /* ignore */ } throw new BodyTooLarge(); }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(buf);
}

function quotaHeaders(q) {
  const reset = new Date(monthStartAfter(q.period || utcMonth(), 1)).toISOString();
  return { 'x-quota-limit': String(q.limit), 'x-quota-remaining': String(Math.max(0, q.limit - q.used)), 'x-quota-reset': reset };
}

// failed authentication is rate limited per IP. Each failure spends one unit of CHECK_LIMITER under
// "authfail:<ip>" (same ~10/min budget as anonymous checks, separate bucket). Once an IP is over, this
// isolate remembers it for 60 s and answers 429 BEFORE any KV lookup. Unknown keys are also negatively cached
// for 60 s in lookupKey, so repeating one bad key never re-reads KV.
const authFailBlocked = new Map(); // ip → blocked-until ms
export function clearAuthFailMemo() { authFailBlocked.clear(); }
const tooManyAuthFailures = () => apiError(429, 'too_many_failed_auth', 'Too many requests with an invalid API key from this IP. Wait a minute.', { 'retry-after': '60' });

/**
 * Who is calling? → { kind:'anon' } | { kind:'key', rec } | { error: Response }.
 * A present-but-bad Authorization header is a 401, never a silent fallback to anonymous.
 */
async function identify(request, env, limits) {
  const raw = extractApiKey(request);
  if (raw === null) return { kind: 'anon' };
  const ip = clientIp(request);
  const until = authFailBlocked.get(ip);
  if (until && until > Date.now()) return { error: tooManyAuthFailures() };
  if (!env.KEYS) return { error: apiError(503, 'keys_unavailable', 'API keys are not available on this deployment yet.') };
  let rec;
  try { rec = await lookupKey(env.KEYS, raw); } catch (e) {
    if (e instanceof StorageError) return { error: apiError(503, 'storage_unavailable', 'Key storage is temporarily unavailable. Please retry shortly.', { 'retry-after': '60' }) };
    throw e;
  }
  if (!rec) {
    if (await limited(env.CHECK_LIMITER, `authfail:${ip}`, limits.anonPerMin)) {
      authFailBlocked.set(ip, Date.now() + 60_000);
      if (authFailBlocked.size > 5000) authFailBlocked.delete(authFailBlocked.keys().next().value);
      return { error: tooManyAuthFailures() };
    }
    return { error: apiError(401, 'invalid_api_key', 'Unknown or malformed API key. Use: Authorization: Bearer bc_live_…', { 'www-authenticate': 'Bearer' }) };
  }
  return { kind: 'key', rec };
}

/**
 * Key gate shared by /v1/* and /mcp (recipe r2 §1). → { ok:true, who } | { ok:false, status, code, message, headers }.
 * Never echoes the key. /v1/* keeps returning identify()'s Response unchanged; /mcp drops www-authenticate (no OAuth).
 */
export async function authenticate(request, env, limits = limitsFor(env)) {
  const who = await identify(request, env, limits);
  if (!who.error) return { ok: true, who };
  const r = who.error;
  let e = {};
  try { e = (await r.clone().json()).error || {}; } catch { /* ignore */ }
  const headers = {};
  for (const h of ['retry-after']) if (r.headers.get(h)) headers[h] = r.headers.get(h);
  return { ok: false, status: r.status, code: e.code || 'auth_error', message: e.message || 'Authentication failed.', headers };
}

/** Rate limit + daily pool + monthly quota for n checks. Returns { error } or { headers }. */
async function admit(who, n, request, env, ctx, limits) {
  if (who.kind === 'anon') {
    const ip = clientIp(request);
    if (await limited(env.CHECK_LIMITER, `ip:${ip}`, limits.anonPerMin)) {
      return { error: apiError(429, 'rate_limited', `Too many checks: about ${limits.anonPerMin} per minute per IP without an API key. Wait a minute or use an API key.`, { 'retry-after': '60' }) };
    }
  } else if (await limited(env.KEY_LIMITER, `key:${who.rec.keyId}`, limits.keyPerMin)) {
    return { error: apiError(429, 'rate_limited', `Too many requests: about ${limits.keyPerMin} per minute per API key.`, { 'retry-after': '60' }) };
  }
  const pool = budgetAllows(who.kind, limits, n);
  if (!pool.ok) {
    return { error: apiError(429, 'daily_capacity_reached', 'BurnerCheck has reached its shared daily capacity. It resets at 00:00 UTC.', { 'retry-after': String(secondsToUtcMidnight()) }) };
  }
  let headers = {};
  if (who.kind === 'key') {
    let q;
    try { q = await consumeMonthlyQuota(env.QUOTA, `key:${who.rec.keyId}`, who.rec.monthly, n); } catch (e) {
      if (e instanceof QuotaUnavailable) return { error: apiError(503, 'quota_unavailable', 'Usage counter temporarily unavailable. Please retry shortly.', { 'retry-after': '30' }) };
      throw e;
    }
    headers = quotaHeaders(q);
    if (!q.ok) {
      const resetIn = Math.ceil((monthStartAfter(q.period || utcMonth(), 1) - Date.now()) / 1000);
      const msg = q.used < q.limit
        ? `This batch needs ${n} checks but only ${q.limit - q.used} remain this month.`
        : `Monthly quota of ${q.limit.toLocaleString('en-US')} checks used. It resets on the 1st (UTC).`;
      return { error: apiError(429, 'quota_exceeded', msg, { ...headers, 'retry-after': String(Math.max(1, resetIn)) }) };
    }
  }
  budgetRecord(who.kind, env.QUOTA, ctx, n);
  return { headers };
}

function fill(tpl, env) {
  return tpl
    .replaceAll('{{VERSION}}', VERSION)
    .replaceAll('{{LIST_VERSION}}', LIST_META.list_version)
    .replaceAll('{{DOMAIN_COUNT}}', LIST_META.domain_count.toLocaleString('en-US'))
    .replaceAll('{{LAST_REFRESH}}', LIST_META.last_refresh.slice(0, 10))
    .replaceAll('{{LIST_COMMIT}}', LIST_META.source.commit)
    .replaceAll('{{CONTACT}}', CONTACT)
    .replaceAll('{{ANON_PER_MIN}}', String(limitsFor(env).anonPerMin));
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const VERDICT_TEXT = {
  invalid: ['bad', 'Invalid', 'This does not look like a valid email address or domain.'],
  disposable: ['bad', 'Disposable', 'On the disposable (throwaway) domain list. Most sign-up forms should reject it.'],
  confusable: ['warn', 'Lookalike domain', 'Uses look-alike characters from another alphabet (for example Cyrillic letters in a Latin name). Treat with suspicion.'],
  role: ['warn', 'Role address', 'A shared or system mailbox, not a person.'],
  free: ['info', 'Free provider', 'Consumer webmail. Fine for people, but not a company address.'],
  unlisted: ['good', 'Not on our disposable list', 'Not on our disposable list, not a role address, not free webmail. New throwaway domains may not be listed yet, and a valid format does not mean the mailbox exists.'],
};

/** Server-rendered result for the no-JS form fallback (POST /). Everything is escaped. */
function resultHtml(r) {
  const [cls, label, text] = VERDICT_TEXT[verdict(r)];
  const flags = [['Valid syntax', r.valid_syntax], ['Disposable', r.disposable], ['Role address', r.role], ['Free provider', r.free_provider], ['Lookalike', r.confusable]]
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<li><span>${k}</span><strong class="${v ? 'y' : 'n'}">${v ? 'yes' : 'no'}</strong></li>`).join('');
  const sugg = r.suggestion ? `<p class="sugg">Did you mean ${escapeHtml(r.suggestion)}?</p>` : '';
  return `<section class="result"><div class="verdict"><span class="badge ${cls}">${label}</span><span>${text}</span></div>`
    + `<p class="small muted">Checked: ${escapeHtml(r.email ?? r.domain ?? '')} · list ${escapeHtml(r.list_version)}</p><ul class="flags">${flags}</ul>${sugg}</section>`;
}
const errorHtml = (msg) => `<p class="err" role="alert">${escapeHtml(msg)}</p>`;

/** Read a size-capped JSON body. → { body } | { error: Response }. Content-Length is checked by the caller first. */
async function readJson(request) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) return { error: apiError(415, 'unsupported_media_type', 'Send Content-Type: application/json.') };
  let text;
  try { text = await readCapped(request, MAX_BODY_BYTES); } catch (e) {
    if (e instanceof BodyTooLarge) return { error: tooLarge() };
    return { error: apiError(400, 'invalid_body', 'Body must be UTF-8 JSON.') };
  }
  try { return { body: JSON.parse(text) }; } catch { return { error: apiError(400, 'invalid_json', 'Body is not valid JSON.') }; }
}
const tooLarge = () => apiError(413, 'body_too_large', `Request body must be at most ${MAX_BODY_BYTES} bytes.`);
const declaredTooLarge = (request) => {
  const cl = request.headers.get('content-length');
  return cl != null && (!/^\d+$/.test(cl) || Number(cl) > MAX_BODY_BYTES);
};

export function createApp({ html = '', docs = '', js = '', css = '' } = {}) {
  const pageCache = new Map();
  const page = (name, tpl, env) => {
    const k = `${name}|${limitsFor(env).anonPerMin}`;
    if (!pageCache.has(k)) pageCache.set(k, fill(tpl, env));
    return pageCache.get(k);
  };

  // Internal call into the exact /v1/* route (same key gate, limiters, pool, quota) for MCP tools (recipe r2 §1).
  // Only the caller's key + client IP headers are forwarded; an email address travels in a POST body, never a URL.
  function runApi(request, env, ctx, { method, path, body }) {
    const h = new Headers({ 'content-type': 'application/json' });
    for (const k of ['authorization', 'cf-connecting-ip']) { const v = request.headers.get(k); if (v !== null) h.set(k, v); }
    return handle(new Request(new URL(path, request.url), { method, headers: h, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx);
  }

  async function sameSecret(a, b) {
    const enc = new TextEncoder();
    const [x, y] = await Promise.all([a, b].map((v) => crypto.subtle.digest('SHA-256', enc.encode(v))));
    const u = new Uint8Array(x), v = new Uint8Array(y);
    let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
    return d === 0;
  }

  async function route(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const limits = limitsFor(env);

    if (path === '/mcp') {
      return handleMcp(request, env, ctx, {
        authenticate: (r, e) => authenticate(r, e, limits), runApi, ipBucket: clientIp(request), memLimit,
        origin: url.origin, allowedOrigins: env.MCP_ALLOWED_ORIGINS, limits, security: { ...SECURITY },
      });
    }

    // ---- machine-readable docs (v0.2.0, recipe r2 §3/§4/§10) ----
    const AGENT_DOCS = ['/llms.txt', '/openapi.json', '/.well-known/mcp/server-card.json', '/.well-known/mcp-registry-auth', '/.well-known/glama.json'];
    if (AGENT_DOCS.includes(path)) {
      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, HEAD, OPTIONS' } });
      if (method !== 'GET' && method !== 'HEAD') return apiError(405, 'method_not_allowed', 'Use GET.', { allow: 'GET, HEAD, OPTIONS' });
      const doc = (body, type, cache = 'public, max-age=3600', status = 200) => new Response(method === 'HEAD' ? null : body, {
        status, headers: { 'content-type': type, 'cache-control': cache, 'access-control-allow-origin': '*', ...SECURITY },
      });
      if (path === '/llms.txt') return doc(llmsTxt(url.origin, limits, AGENT_X), 'text/plain; charset=utf-8');
      if (path === '/openapi.json') return doc(JSON.stringify(openApiSpec(url.origin, limits, AGENT_X), null, 2), 'application/json; charset=utf-8');
      if (path === '/.well-known/mcp/server-card.json') return doc(JSON.stringify(serverCard(url.origin), null, 2), 'application/json; charset=utf-8');
      if (path === '/.well-known/glama.json') return doc(glamaJson(), 'application/json; charset=utf-8');
      const v = String(env.MCP_REGISTRY_AUTH || '');
      if (/^v=MCPv1; k=(ed25519|ecdsap384); p=[A-Za-z0-9+/=]{20,120}$/.test(v)) return doc(v, 'text/plain; charset=utf-8', 'no-store');
      return doc('Not found\n', 'text/plain; charset=utf-8', 'no-store', 404);
    }

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS } });

    // ---- static pages ----
    const asset = (body, type, extra = {}) => new Response(method === 'HEAD' ? null : body, {
      headers: { 'content-type': type, 'cache-control': 'public, max-age=300', ...SECURITY, 'content-security-policy': CSP, ...extra },
    });
    if (method === 'GET' || method === 'HEAD') {
      if (path === '/') return asset(page('index', html, env).replace('{{NOJS_RESULT}}', ''), 'text/html; charset=utf-8');
      if (path === '/docs' || path === '/docs/') return asset(page('docs', docs, env), 'text/html; charset=utf-8');
      if (path === '/app.js') return asset(js, 'text/javascript; charset=utf-8');
      if (path === '/style.css') return asset(css, 'text/css; charset=utf-8');
      if (path === '/privacy') return Response.redirect(new URL('/docs#privacy', url).toString(), 301);
      if (path === '/robots.txt') {
        const body = isStaging(env) ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nAllow: /\nDisallow: /v1/\n';
        return asset(body, 'text/plain; charset=utf-8');
      }
      if (path === '/favicon.ico') return new Response(null, { status: 204, headers: { 'cache-control': 'public, max-age=86400' } });
    }

    // No-JS fallback for the checker form: POST keeps the address out of the URL and history. Same 16 KB cap
    // and the same anonymous per-IP limiter / daily pool as the API.
    if (path === '/' && method === 'POST') {
      const render = (inner, status = 200) => new Response(page('index', html, env).replace('{{NOJS_RESULT}}', inner), {
        status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY, 'content-security-policy': CSP },
      });
      if (declaredTooLarge(request)) return render(errorHtml('Request too large.'), 413);
      let text;
      try { text = await readCapped(request, MAX_BODY_BYTES); } catch (e) {
        return e instanceof BodyTooLarge ? render(errorHtml('Request too large.'), 413) : render(errorHtml('Could not read the form.'), 400);
      }
      const q = (new URLSearchParams(text).get('q') || '').trim();
      if (!q) return render(errorHtml('Enter an email address or a domain.'), 400);
      if (q.length > MAX_INPUT) return render(errorHtml(`Please enter at most ${MAX_INPUT} characters.`), 400);
      const ok = await admit({ kind: 'anon' }, 1, request, env, ctx, limits);
      if (ok.error) return render(errorHtml((await ok.error.clone().json()).error.message), ok.error.status);
      return render(resultHtml(q.includes('@') ? checkEmail(q) : checkDomain(q)));
    }

    if (!path.startsWith('/v1/')) return apiError(404, 'not_found', 'Not found. API docs: /docs');

    // ---- API ----
    // v0.2.2: daily request totals for the operator's weekly report. 404 unless STATS_TOKEN (a Worker secret)
    // is set and sent as a Bearer token. Returns integers per UTC day only.
    if (path === '/v1/stats') {
      const tok = String(env.STATS_TOKEN || '');
      const auth = request.headers.get('authorization') || '';
      if (tok.length < 24 || method !== 'GET' || !(await sameSecret(auth, `Bearer ${tok}`)) || !env.QUOTA) return apiError(404, 'not_found', 'Unknown API route. See /docs');
      try {
        const r = await env.QUOTA.get(env.QUOTA.idFromName(BUDGET_DO_NAME)).fetch('https://quota/requests');
        return json(await r.json(), 200, { 'cache-control': 'no-store' });
      } catch { return apiError(503, 'stats_unavailable', 'Try again later.'); }
    }

    if (path === '/v1/meta') {
      if (method !== 'GET' && method !== 'HEAD') return apiError(405, 'method_not_allowed', 'Use GET.', { allow: 'GET' });
      return json({
        service: 'burnercheck',
        version: VERSION,
        build: String(env.BUILD_SHA || 'dev'), // git short SHA, set at deploy (scripts/deploy-staging.sh)
        list_version: LIST_META.list_version,
        domain_count: LIST_META.domain_count,
        allowlist_count: LIST_META.allowlist_count,
        last_refresh: LIST_META.last_refresh,
        source: LIST_META.source,
        limits: {
          anonymous_per_min: limits.anonPerMin,
          key_per_min: limits.keyPerMin,
          batch_max: MAX_BATCH,
          max_body_bytes: MAX_BODY_BYTES,
          plans: Object.fromEntries(Object.entries(PLANS).map(([k, v]) => [k, { checks_per_month: v.monthly, batch: v.batch }])),
        },
      });
    }

    if (path === '/v1/check') {
      // POST {"email": …} is the recommended form (keeps the address out of URLs); GET ?email= stays for API users.
      if (method !== 'GET' && method !== 'POST') return apiError(405, 'method_not_allowed', 'Use POST /v1/check with {"email":"…"} (recommended) or GET /v1/check?email=….', { allow: 'GET, POST' });
      let email;
      let who;
      if (method === 'POST') {
        if (declaredTooLarge(request)) return tooLarge();
        who = await identify(request, env, limits);
        if (who.error) return who.error;
        const parsed = await readJson(request);
        if (parsed.error) return parsed.error;
        const b = parsed.body;
        if (!b || typeof b !== 'object' || Array.isArray(b)) return apiError(400, 'invalid_body', 'Expected {"email": "someone@example.com"}.');
        if (b.email != null && typeof b.email !== 'string') return apiError(400, 'invalid_body', 'email must be a string.');
        email = b.email;
      } else {
        email = url.searchParams.get('email');
      }
      if (email == null || !email.trim()) return apiError(400, 'missing_email', method === 'POST' ? 'Send {"email": "someone@example.com"}.' : 'Add ?email=someone@example.com (or POST {"email": …}).');
      if (email.length > MAX_INPUT) return apiError(400, 'input_too_long', `email must be at most ${MAX_INPUT} characters.`);
      if (!who) {
        who = await identify(request, env, limits);
        if (who.error) return who.error;
      }
      const ok = await admit(who, 1, request, env, ctx, limits);
      if (ok.error) return ok.error;
      return json(checkEmail(email), 200, ok.headers);
    }

    if (path.startsWith('/v1/domain/') || path === '/v1/domain') {
      if (method !== 'GET') return apiError(405, 'method_not_allowed', 'Use GET /v1/domain/{domain}.', { allow: 'GET' });
      let d;
      try { d = decodeURIComponent(path.slice('/v1/domain/'.length)); } catch { d = ''; }
      if (!d) return apiError(400, 'missing_domain', 'Use GET /v1/domain/example.com');
      if (d.length > 253) return apiError(400, 'input_too_long', 'domain must be at most 253 characters.');
      if (d.includes('@') || d.includes('/')) return apiError(400, 'domain_only', 'This endpoint takes a domain only (no local part, no "@"). For a full address use POST /v1/check with {"email": …}.');
      const who = await identify(request, env, limits);
      if (who.error) return who.error;
      const ok = await admit(who, 1, request, env, ctx, limits);
      if (ok.error) return ok.error;
      return json(checkDomain(d), 200, ok.headers);
    }

    if (path === '/v1/check/batch') {
      if (method !== 'POST') return apiError(405, 'method_not_allowed', 'Use POST with {"emails":[…]}.', { allow: 'POST' });
      // 1) Declared size: reject before reading or parsing anything.
      if (declaredTooLarge(request)) return tooLarge();
      // 2) Paid key required.
      const who = await identify(request, env, limits);
      if (who.error) return who.error;
      if (who.kind !== 'key') return apiError(401, 'api_key_required', 'Batch checks need a paid API key: Authorization: Bearer bc_live_…', { 'www-authenticate': 'Bearer' });
      if (!who.rec.batch) return apiError(403, 'paid_plan_required', 'Batch checks are planned for paid plans (Pro, Business), which are not on sale yet. Free keys can use /v1/check.');
      // 3) Actual bytes (covers chunked bodies and lying Content-Length).
      const parsed = await readJson(request);
      if (parsed.error) return parsed.error;
      const body = parsed.body;
      const emails = body && Array.isArray(body.emails) ? body.emails : null;
      if (!emails) return apiError(400, 'invalid_body', 'Expected {"emails": ["a@example.com", …]}.');
      if (emails.length === 0) return apiError(400, 'empty_batch', 'emails must contain at least one address.');
      if (emails.length > MAX_BATCH) return apiError(400, 'too_many_emails', `At most ${MAX_BATCH} emails per batch (got ${emails.length}).`);
      const badIdx = emails.findIndex((e) => typeof e !== 'string' || e.length > MAX_INPUT);
      if (badIdx >= 0) return apiError(400, 'invalid_email_item', `emails[${badIdx}] must be a string of at most ${MAX_INPUT} characters.`);
      const ok = await admit(who, emails.length, request, env, ctx, limits);
      if (ok.error) return ok.error;
      return json({ count: emails.length, list_version: LIST_META.list_version, results: emails.map(checkEmail) }, 200, ok.headers);
    }

    return apiError(404, 'not_found', 'Unknown API route. See /docs');
  }

  async function handle(request, env = {}, ctx = {}) {
    // v0.2.2: +1 to today's total; no identifier recorded. v0.2.3: operator /v1/stats reads are not counted.
    if (new URL(request.url).pathname !== '/v1/stats') recordRequest(env.QUOTA, ctx);
    let res;
    try {
      res = await route(request, env, ctx);
    } catch {
      // Never a Workers 1101 page; never echo input. Nothing is logged (no addresses are ever logged).
      res = apiError(500, 'internal_error', 'Something went wrong. Please try again.');
    }
    if (isStaging(env)) {
      res = new Response(res.body, res);
      res.headers.set('x-robots-tag', 'noindex, nofollow');
    }
    return res;
  }
  return handle;
}
