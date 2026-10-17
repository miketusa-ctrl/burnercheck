# BurnerCheck

Disposable email checker: disposable, role, free-mail and look-alike flags. List-based, no MX.

## Live service

- Web app and API: https://burnercheck.mike-tusa.workers.dev/
- Pricing and plans: https://burnercheck.mike-tusa.workers.dev/docs
- Support: digitalpromohub.support@gmail.com

## Use it from an AI assistant (MCP)

BurnerCheck is a remote MCP server (Streamable HTTP) at `https://burnercheck.mike-tusa.workers.dev/mcp`. Tools: `check_email`, `check_domain`, `get_meta`.

Most MCP clients (Claude Desktop, Cursor, Cline, Windsurf) accept this config:

```json
{
  "mcpServers": {
    "burnercheck": {
      "type": "http",
      "url": "https://burnercheck.mike-tusa.workers.dev/mcp"
    }
  }
}
```

Clients that only support stdio can bridge with `npx mcp-remote https://burnercheck.mike-tusa.workers.dev/mcp`. VS Code uses a `servers` key instead of `mcpServers`.

The `server.json` file is the [MCP Registry](https://registry.modelcontextprotocol.io) manifest for this server.

## Run your own copy

Requires Node.js 20+ and a Cloudflare account.

```bash
npm install
npx wrangler dev        # local dev server
```

`wrangler.toml` is a template: create your own KV namespaces / D1 databases / rate-limit namespaces and replace the `<PLACEHOLDER>` values before `npx wrangler deploy`. Any secrets the Worker reads go in `wrangler secret put` (or `.dev.vars` locally), never in the repo.

## Third-party data

Disposable-domain list from [disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains) (CC0-1.0); see `data/`.

## License

MIT (c) Digital Promo Hub. See [LICENSE](LICENSE).
