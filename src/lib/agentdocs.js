// llms.txt, OpenAPI 3.1 and the MCP server card, generated from code constants and limitsFor(env) (agent-ready
// recipe r2 §3/§4). No number is hard-coded twice; drift tests in test/agent.test.js keep these in step with the router.
import { TOOLS, SUPPORTED_VERSIONS, DISCOVERY_PER_MIN, MAX_BODY_BYTES, SERVER_INFO, CHECK_OUT } from './mcp.js';
import { VERSION } from './version.js';

export const CONTACT = 'digitalpromohub.support@gmail.com';
export const mcpClientConfig = (origin) => ({ mcpServers: { burnercheck: { type: 'http', url: `${origin}/mcp` } } });

export const llmsTxt = (origin, L, X) => `# BurnerCheck

> Disposable (throwaway) email checker: checks an email address or a domain against the open-source disposable-email-domains list (CC0) and flags role addresses, free webmail providers, look-alike domains and likely typos. List-based and offline (no MX/DNS lookup, no mail server contact). Public JSON API plus a remote MCP server for AI agents. Addresses are processed in memory and not stored or logged.

## For AI agents

- [MCP server](${origin}/mcp): remote MCP over Streamable HTTP (POST only, stateless, JSON responses). Protocol versions: ${SUPPORTED_VERSIONS.join(', ')}. Tools: ${TOOLS.map((t) => `\`${t.name}\`${Object.keys(t.inputSchema.properties).length ? ` (${Object.keys(t.inputSchema.properties).join(', ')})` : ''}`).join(', ')}. Read-only. Client config (most MCP clients accept this; some use a different format, for example VS Code uses a \`servers\` key): \`${JSON.stringify(mcpClientConfig(origin))}\`
- [OpenAPI 3.1 spec](${origin}/openapi.json): machine-readable description of the JSON API
- [Docs](${origin}/docs): human-readable API docs

## JSON API

- \`POST ${origin}/v1/check\` with JSON \`{"email": "jane@mailinator.com"}\` (recommended: keeps the address out of URLs): valid_syntax, disposable, role, free_provider, confusable, suggestion, list_version. \`GET /v1/check?email=\` also works but puts the address in a URL.
- \`GET ${origin}/v1/domain/{domain}\`: domain only (anything with "@" returns 400 domain_only). Prefer this when you don't need the local part.
- \`POST ${origin}/v1/check/batch\` with \`{"emails": [...]}\`: up to ${X.batchMax} addresses, paid keys only (paid plans are not on sale yet).
- \`GET ${origin}/v1/meta\`: version, list version and size, source, limits.
- Errors: { "error": { "code", "message" } } with 400 (missing_email, missing_domain, input_too_long, domain_only, invalid_body, invalid_json, empty_batch, too_many_emails, invalid_email_item), 401 (invalid_api_key, api_key_required), 403 (paid_plan_required), 404 (not_found), 405 (method_not_allowed), 413 (body_too_large), 415 (unsupported_media_type), 429 (rate_limited, too_many_failed_auth, daily_capacity_reached, quota_exceeded), 503 (keys_unavailable, storage_unavailable, quota_unavailable).
- "Not disposable" means "not on our list": new throwaway domains may not be listed yet, and a valid format does not mean the mailbox exists.

## Limits and keys

- Anonymous: about ${L.anonPerMin} checks/min per IP. API key (\`Authorization: Bearer bc_live_...\`, issued by request during early access): about ${L.keyPerMin}/min; free plan ${X.plans.free.monthly} checks per month. A shared daily capacity applies. The MCP endpoint uses the same keys and counters: each \`check_email\` / \`check_domain\` call is one check; \`get_meta\` and non-call messages don't count, but are capped at about ${DISCOVERY_PER_MIN}/min per IP (HTTP 429 + Retry-After).

## Optional

- [Privacy](${origin}/docs#privacy): addresses are not stored or logged; the web checker sends them in POST bodies only.
- Source list: disposable-email-domains (CC0), refreshed weekly.
- Contact: ${CONTACT}
`;

const errSchema = { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] } }, required: ['error'] };
const resp = (d) => ({ description: d, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });
const H = (d) => ({ description: d, schema: { type: 'string' } });
const okHeaders = { 'x-quota-limit': H('Monthly quota, keyed calls only'), 'x-quota-remaining': H('Checks left this month, keyed calls only'), 'x-quota-reset': H('Quota reset time (ISO 8601), keyed calls only') };
const r429 = { description: 'rate_limited, too_many_failed_auth, daily_capacity_reached or quota_exceeded', headers: { 'retry-after': H('Seconds to wait') }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const ok = (schema) => ({ description: 'Result', headers: okHeaders, content: { 'application/json': { schema } } });

export function openApiSpec(origin, L, X) {
  const check = { $ref: '#/components/schemas/CheckResult' };
  const paths = {
    '/v1/check': {
      post: {
        operationId: 'checkEmail', summary: 'Check one email address (recommended form: the address stays out of URLs)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string', maxLength: X.maxInput } }, required: ['email'] } } } },
        responses: { 200: ok(check), 400: resp('Bad input'), 401: resp('invalid_api_key'), 413: resp('body_too_large'), 415: resp('unsupported_media_type'), 429: r429, 500: resp('internal_error'), 503: resp('keys_unavailable, storage_unavailable or quota_unavailable') },
      },
      get: {
        operationId: 'checkEmailGet', summary: 'Same check with the address in the query string (prefer POST)',
        parameters: [{ name: 'email', in: 'query', required: true, schema: { type: 'string', maxLength: X.maxInput } }],
        responses: { 200: ok(check), 400: resp('Bad input'), 401: resp('invalid_api_key'), 429: r429, 503: resp('Unavailable') },
      },
    },
    '/v1/domain/{domain}': { get: {
      operationId: 'checkDomain', summary: 'Check a domain only (no local part)',
      parameters: [{ name: 'domain', in: 'path', required: true, schema: { type: 'string', maxLength: 253 } }],
      responses: { 200: ok(check), 400: resp('missing_domain, input_too_long or domain_only'), 401: resp('invalid_api_key'), 405: resp('method_not_allowed'), 429: r429, 503: resp('Unavailable') },
    } },
    '/v1/check/batch': { post: {
      operationId: 'checkBatch', summary: `Check up to ${X.batchMax} addresses (paid keys only; each address counts one check)`,
      security: [{ bearerAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { emails: { type: 'array', minItems: 1, maxItems: X.batchMax, items: { type: 'string', maxLength: X.maxInput } } }, required: ['emails'] } } } },
      responses: { 200: ok({ type: 'object', properties: { count: { type: 'integer' }, list_version: { type: 'string' }, results: { type: 'array', items: check } } }), 400: resp('Bad input'), 401: resp('api_key_required or invalid_api_key'), 403: resp('paid_plan_required'), 405: resp('method_not_allowed'), 413: resp('body_too_large'), 429: r429, 503: resp('Unavailable') },
    } },
    '/v1/meta': { get: { operationId: 'meta', summary: 'Version, list version and size, source and limits', security: [{}], responses: { 200: { description: 'Meta', content: { 'application/json': { schema: { type: 'object' } } } } } } },
    '/mcp': {
      post: {
        operationId: 'mcp', summary: `MCP JSON-RPC 2.0 (Streamable HTTP, stateless). Protocol versions ${SUPPORTED_VERSIONS.join(', ')}. Max body ${MAX_BODY_BYTES} bytes.`,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { 200: { description: 'JSON-RPC response (tool errors are results with isError)', headers: okHeaders }, 202: { description: 'Notification or client response accepted' }, 400: { description: 'Parse error, invalid request, header mismatch or unsupported version' }, 401: { description: 'invalid_api_key (no WWW-Authenticate)' }, 403: { description: 'Origin not allowed' }, 404: { description: 'Unknown method (2026-07-28)' }, 413: { description: 'Body too large' }, 429: { description: 'Too many MCP requests or failed keys', headers: { 'retry-after': H('Seconds') } }, 500: { description: 'Internal error' }, 503: { description: 'keys_unavailable or storage_unavailable' } },
      },
      get: { operationId: 'mcpGet', summary: 'Not supported (stateless, no SSE)', responses: { 405: { description: 'Method not allowed', headers: { allow: { schema: { type: 'string', enum: ['POST, OPTIONS'] } } } } } },
      delete: { operationId: 'mcpDelete', summary: 'Not supported (no sessions)', responses: { 405: { description: 'Method not allowed', headers: { allow: { schema: { type: 'string', enum: ['POST, OPTIONS'] } } } } } },
    },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'BurnerCheck', version: VERSION, description: `Disposable email checker (disposable-email-domains list, CC0; list-based and offline, no MX/DNS lookup). Addresses are not stored or logged. Anonymous ~${L.anonPerMin}/min per IP; API key ~${L.keyPerMin}/min.`, contact: { email: CONTACT } },
    servers: [{ url: origin }],
    security: [{}, { bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'bc_live_… API key' } }, schemas: { Error: errSchema, CheckResult: CHECK_OUT } },
    paths,
  };
}

export const serverCard = (origin) => ({
  serverInfo: { name: SERVER_INFO.name, title: SERVER_INFO.title, version: VERSION },
  transport: { type: 'streamable-http', url: `${origin}/mcp` },
  authentication: { required: false },
  tools: TOOLS, resources: [], prompts: [],
});

// v0.2.3: Glama connector ownership claim (served at /.well-known/glama.json). Token transcribed from the
// Glama "HTTP file" screen (28cO = capital letter O; VI1BI = capital i, digit one, capital B, capital i).
export const GLAMA_CLAIM = '<GLAMA_CLAIM_TOKEN>';
export const glamaJson = () => JSON.stringify({ $schema: 'https://glama.ai/mcp/schemas/connector.json', claim: GLAMA_CLAIM }, null, 2);
