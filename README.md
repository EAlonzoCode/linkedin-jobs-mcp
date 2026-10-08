# LinkedIn Jobs MCP

> MCP server for LinkedIn job search. **No login, no API keys, no dependencies, one file.**

Talk to any MCP-compatible client (OpenCode, Claude Desktop, Claude Code, …) and search
LinkedIn job postings, then pull the full description, hiring criteria and applicant count —
all without touching your LinkedIn account.

```jsonc
// "Find me junior Python roles in Santiago with few applicants"
// → search-jobs { keywords: "backend python junior", location: "Santiago, Chile" }
// → get-job-details { jobId: "4471579965" }
```

---

## Why this one

| | Browser-session MCPs | Official LinkedIn API | **This server** |
|---|---|---|---|
| LinkedIn login / cookies | ✅ required | ✅ OAuth app | ❌ **none** |
| Headless browser | ✅ Playwright/Chromium | ❌ | ❌ **none** |
| Dependencies | dozens | SDK + tokens | **0** |
| Files | `node_modules/` | `node_modules/` | **1 file** |
| Job search endpoint | scraping | ❌ **doesn't exist** | ✅ |
| Risk to your account | ⚠️ automates your session | none | **none — your account is never involved** |

LinkedIn's official API has **no job search endpoint for third parties**. That's the whole
reason this exists.

---

## Requirements

- **Node.js ≥ 18** (uses the built-in `fetch`)
- Nothing else. No `npm install`.

## Install

```bash
git clone https://github.com/EAlonzoCode/linkedin-jobs-mcp.git
cd linkedin-jobs-mcp
npm test        # optional: protocol smoke test, fully offline
```

## Client configuration

**OpenCode** — `~/.config/opencode/opencode.json`

```json
{
  "mcp": {
    "servers": {
      "linkedin-jobs": {
        "type": "local",
        "command": ["node", "/absolute/path/to/linkedin-jobs-mcp/server.mjs"]
      }
    }
  }
}
```

**Claude Desktop / Claude Code**

```json
{
  "mcpServers": {
    "linkedin-jobs": {
      "command": "node",
      "args": ["/absolute/path/to/linkedin-jobs-mcp/server.mjs"]
    }
  }
}
```

Use **absolute paths** — some hosts don't apply the working directory you expect, and a
relative path will fail silently with `Connection closed`.

---

## Tools

### `search-jobs`

| Param | Type | Required | Description |
|---|---|---|---|
| `keywords` | string | ✅ | e.g. `"Data Analyst"`, `"analista de datos junior"` |
| `location` | string | — | e.g. `"Santiago, Chile"`; empty = any |
| `start` | number | — | pagination offset (`0`, `25`, `50`, …), default `0` |
| `limit` | number | — | 1–50, default 25 |

```json
{
  "count": 3,
  "start": 0,
  "jobs": [
    {
      "id": "4471579965",
      "title": "Developer Back-end Python + Fastapi",
      "company": "BC Tecnología",
      "location": "Gran Santiago, Región Metropolitana de Santiago, Chile",
      "postedAt": "2026-09-28",
      "url": "https://es.linkedin.com/jobs/view/...-4471579965"
    }
  ]
}
```

### `get-job-details`

| Param | Type | Required | Description |
|---|---|---|---|
| `jobId` | string | ✅ | full job URL **or** the numeric id from `search-jobs` |

```json
{
  "id": "4471579965",
  "title": "Developer Back-end Python + Fastapi",
  "company": "BC Tecnología",
  "location": "Gran Santiago, Región Metropolitana de Santiago, Chile",
  "description": "En BC Tecnología somos una consultora TI…",
  "criteria": [
    { "label": "Nivel de antigüedad", "value": "Intermedio" },
    { "label": "Tipo de empleo", "value": "Jornada completa" },
    { "label": "Sectores", "value": "Tecnología, información e internet" }
  ],
  "applicants": "72 solicitudes",
  "postedRelative": "Hace 1 semana",
  "easyApply": false
}
```

`criteria`, `applicants`, `postedRelative` and `easyApply` are optional — LinkedIn omits them
on some postings.

---

## How it works

```
MCP client ⇄ stdio (newline-delimited JSON-RPC) ⇄ server.mjs ⇄ LinkedIn public endpoints
```

- **Transport**: hand-written. Handles `initialize`, `ping`, `tools/list`, `tools/call`,
  `resources/list`, `prompts/list`. No `@modelcontextprotocol/sdk` needed.
- **Endpoints**: the logged-out Jobs page —
  `/jobs-guest/jobs/api/seeMoreJobPostings/search` for listings, and the public
  `/jobs/view/{id}` page for details.
- **Parsing**: targeted regex over flat, stable markup. Deliberately no HTML parser
  dependency — that's what keeps it at one file.
- **stdout carries only JSON-RPC.** Logs go to **stderr**, because writing logs to stdout
  corrupts the MCP stream and clients disconnect with `Connection closed`.
- **Rate limiting**: a 600 ms floor between requests, enforced globally. Keep it.

### Rate limit / `search returned no cards`

If LinkedIn starts rate-limiting your IP you'll get empty results or an HTTP 429. Wait a few
minutes. Do **not** lower `MIN_GAP_MS` or add proxy rotation — that's how a tool like this
gets an IP block and breaks for everyone.

---

## Limitations

Read this before using it.

- **Read-only, jobs only.** No `send-message`, no `connect`, no feed, no profile scraping
  beyond the public job pages. Those genuinely require an authenticated session, and this
  server deliberately doesn't have one.
- **Not affiliated with, endorsed by, or connected to LinkedIn or Microsoft.** LinkedIn is a
  trademark of LinkedIn Corporation.
- **Endpoints are undocumented and will change.** Already happened once:
  `/jobs-guest/jobs/api/view/{id}` returned **404** and detail lookups had to move to the
  public job page. Expect selector rot; PRs welcome.
- **Automated access may conflict with LinkedIn's User Agreement.** These are public,
  logged-out pages and your account is never involved, but it is still automated access.
  Use it in moderation, personally, and at your own discretion. This project makes no claim
  that it's permitted.
- **No warranty.** See `LICENSE`.

---

## Development

```bash
npm test                 # protocol smoke test, offline, no network
npm start                # run the server on stdio (Ctrl-C to stop)
LOG_LEVEL=debug npm start
```

Adding a tool = add an entry to the `TOOLS` array + a branch in `callTool()`. The transport
does the rest.

## License

[MIT](LICENSE) © Esteban Alonzo
