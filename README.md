# LinkedIn Jobs MCP

[![CI](https://github.com/EAlonzoCode/linkedin-jobs-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/EAlonzoCode/linkedin-jobs-mcp/actions/workflows/ci.yml)
[![Node ≥ 18](https://img.shields.io/badge/node-%E2%89%A5%2018-339933)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](#why-this-one)

> MCP server for job search across **7 boards**. **No login, no API keys, no dependencies.**

Talk to any MCP-compatible client (OpenCode, Claude Desktop, Claude Code, …) and search
LinkedIn, Computrabajo, Greenhouse, Lever, Ashby, RemoteOK and Remotive in one call —
de-duplicated, then pull the full description for any result. Your LinkedIn account is
never involved.

```jsonc
// "Find me junior Python roles in Santiago with few applicants"
// → search-all { keywords: "backend python junior", location: "Santiago, Chile" }
// → get-job-details { source: "linkedin", id: "4471579965" }
```

---

## Why this one

| | Browser-session MCPs | Official LinkedIn API | **This server** |
|---|---|---|---|
| LinkedIn login / cookies | ✅ required | ✅ OAuth app | ❌ **none** |
| Headless browser | ✅ Playwright/Chromium | ❌ | ❌ **none** |
| Dependencies | dozens | SDK + tokens | **0** |
| Job search source | scrapes your logged-in browser DOM | ❌ **doesn't exist** | public logged-out pages |
| Risk to your account | ⚠️ automates your session | none | **none — your account is never involved** |

LinkedIn's official API has **no job search endpoint for third parties**. That's the whole
reason this exists — and the reason the other six boards are here too.

---

## Sources

Each source is one file in `sources/`, implementing `search()` and optionally `details()`.

| Source | Type | How it is read | Notes |
|---|---|---|---|
| **LinkedIn** | board | public logged-out pages | no account involved; 600 ms pause |
| **Computrabajo** | board 🇨🇱 | server-rendered HTML + schema.org JSON-LD | Chile + ~20 LatAm countries |
| **Greenhouse** | ATS | [published public board API](https://developers.greenhouse.io/) | needs `org` |
| **Lever** | ATS | [published public board API](https://developer.lever.co/) | needs `org`; ships descriptions inline |
| **Ashby** | ATS | [published public board API](https://developers.ashbyhq.com/) | needs `org`; includes compensation |
| **RemoteOK** | remote | public JSON feed | includes salary ranges |
| **Remotive** | remote | [public JSON API](https://remotive.com/api/remote-jobs) | server-side search |

**Greenhouse, Lever and Ashby are ATS vendors, not job boards.** One `org` reaches every
company running on that platform — Airbnb on Greenhouse, Ramp and Notion on Ashby — so
coverage grows with the platform rather than with a hand-written scraper.

Dropped after testing: **Torre** (now serves an app shell instead of JSON) and
**SmartRecruiters** (API responds, but no working company slug could be confirmed).

---

## Requirements

- **Node.js ≥ 18** (uses the built-in `fetch`)
- Nothing else. No `npm install`.

## Install

```bash
git clone https://github.com/EAlonzoCode/linkedin-jobs-mcp.git
cd linkedin-jobs-mcp
npm test        # optional: 31 offline tests
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

Nine tools: one aggregate, one per source, one for details.

### `search-all` — start here

Searches every keyword source at once, runs them concurrently, and merges duplicates so the
same posting doesn't appear three times.

| Param | Type | Required | Description |
|---|---|---|---|
| `keywords` | string | ✅ | e.g. `"Data Analyst"`, `"analista de datos junior"` |
| `location` | string | — | e.g. `"Santiago, Chile"`; empty = any |
| `sources` | string[] | — | restrict to specific sources, e.g. `["computrabajo"]` |
| `perSource` | number | — | results kept per source, default **5** |
| `maxResults` | number | — | total cap after de-duplication, default 30 |

```jsonc
{
  "count": 10,
  "sources": [
    { "source": "linkedin",     "ok": true, "returned": 3, "total": 10, "ms": 783 },
    { "source": "computrabajo", "ok": true, "returned": 3, "total": 30, "ms": 811 },
    { "source": "remoteok",     "ok": true, "returned": 2, "total": 2,  "ms": 1124 },
    { "source": "remotive",     "ok": true, "returned": 3, "total": 15, "ms": 534 }
  ],
  "skipped": "greenhouse, lever, ashby need an \"org\" (company slug) — use their own tool.",
  "jobs": [
    {
      "source": "computrabajo",
      "id": "D4A19C0A6C1D6E861373E686DCF3405",
      "title": "Data Engineer Gobierno y Seguridad",
      "company": "BCTecnología",
      "location": "Santiago Centro, R.Metropolitana",
      "url": "https://cl.computrabajo.com/ofertas-de-trabajo/…"
    }
  ]
}
```

`sources` reports per-source status rather than failing the whole call — one dead board
never costs you the other six. A source that errors is listed with its reason.

### `search-{source}`

`search-linkedin`, `search-computrabajo`, `search-remoteok`, `search-remotive`,
`search-greenhouse`, `search-lever`, `search-ashby`.

| Param | Type | Required | Description |
|---|---|---|---|
| `keywords` | string | ✅* | search terms — required unless noted below |
| `org` | string | ✅* | **instead of `keywords`** for the three ATS sources |
| `location` | string | — | city or region; empty = any |
| `start` | number | — | pagination offset (`0`, `25`, `50`, …) |
| `limit` | number | — | 1–50, default 25 |
| `fields` | string | — | `"summary"` (default) or `"full"` |

\* The ATS boards are addressed per company, so `search-greenhouse` requires `org` — the
slug in the board URL, e.g. `"airbnb"`. They have no keyword search of their own, so
filtering happens client-side.

### `fields` — the token control

Job descriptions are the expensive part of any listing, so they are **opt-in**:

| `fields` | Includes | Size |
|---|---|---|
| `"summary"` *(default)* | source, id, title, company, location, url, postedAt, salary | **small** |
| `"full"` | adds description, tags, category, department, work mode… | +900 % |

Measured on a 5-result query: `search-remoteok` returned **1 378 bytes** as `summary`
versus **34 600 bytes** as `full` — **96 % smaller**. `search-all` always returns
summaries. Reach for `fields: "full"` only when you actually need the description, or call
`get-job-details` for a single posting.

### `get-job-details`

| Param | Type | Required | Description |
|---|---|---|---|
| `source` | string | ✅ | which board the job came from |
| `id` | string | ✅ | job id as returned by a search tool |
| `org` | string | — | **required for `greenhouse` and `lever`** |

Pretty-printed (search results are compact JSON; a single job is meant to be read).

```jsonc
// get-job-details { source: "computrabajo", id: "2012FF9052D1781961373E686DCF3405" }
{
  "id": "2012FF9052D1781961373E686DCF3405",
  "source": "computrabajo",
  "title": "Desarrollador con Python",
  "company": "Abenis",
  "location": "Santiago - Las condes, R.Metropolitana",
  "country": "Chile",
  "postedAt": "2026-09-04",
  "validThrough": "2026-11-03",
  "employmentType": "OTHER",
  "description": "Hola a Todos!\nEn Abenis estamos constantemente Reclutando…"
}
```

LinkedIn additionally returns `criteria` (seniority, employment type, sectors), `applicants`
and `easyApply`. `greenhouse`, `lever`, `ashby` and `computrabajo` return the full
description. `remoteok` and `remotive` ship it inline, so they have no `details()`.

---

## How it works

```
MCP client ⇄ stdio (newline-delimited JSON-RPC) ⇄ server.mjs ⇄ core/ ⇄ sources/ ⇄ 7 boards
```

- **Transport**: hand-written. Handles `initialize`, `ping`, `tools/list`, `tools/call`,
  `resources/list`, `prompts/list`. No `@modelcontextprotocol/sdk` needed.
- **stdout carries only JSON-RPC.** Logs go to **stderr**, because writing logs to stdout
  corrupts the MCP stream and clients disconnect with `Connection closed`.
- **Rate limiting is per host**, because the boards deserve different treatment:
  LinkedIn waits 600 ms, Computrabajo 400 ms, and the published ATS APIs ~60 ms — they
  exist to be called.
- **Aggregate searches run concurrently** (4 at a time) with a 12 s per-source ceiling, so
  one slow board can't stall the call. Failures are reported, not thrown.

### Layout

```
├── server.mjs              transport + tool wiring (tools built from the registry)
├── core/
│   ├── http.js             fetch, per-host rate limits, timeouts, mapLimit
│   ├── html.js             text(), match(), decodeEntities()
│   ├── filter.js           client-side keyword/location matching
│   ├── dedupe.js           cross-source de-duplication
│   ├── registry.js         the source list
│   └── log.js
├── sources/                one file per board
│   ├── linkedin.js  greenhouse.js  lever.js  ashby.js
│   ├── computrabajo.js  remoteok.js  remotive.js
└── test/protocol.test.mjs  31 offline tests
```

### Adding a source

Create `sources/acme.js`, export the contract, add it to `core/registry.js`:

```js
export default {
  id: 'acme',                 // becomes search-acme
  name: 'Acme',
  blurb: 'One line the model reads when choosing a source.',
  // needsOrg: true           // uncomment for per-company ATS boards
  // optionalKeywords: true   // uncomment if keywords are optional

  async search({ keywords, location = '', start = 0, limit = 25 }) {
    return { count, jobs: [{ id, title, company, location, url }] }
  },
  async details({ id }) { /* optional */ }
}
```

`server.mjs` builds the tool, `search-all` picks it up, and the contract test checks the
shape — none of them need editing.

### Rate limit / `search returned no cards`

If LinkedIn starts rate-limiting your IP you'll get empty results or an HTTP 429. Wait a few
minutes. Do **not** lower `HOST_GAP_MS`, add proxy rotation or rotate fingerprints — that's
how a tool like this gets an IP block and breaks for everyone.

---

## Limitations

Read this before using it.

- **Read-only, jobs only.** No `send-message`, no `connect`, no feed, no profile scraping
  beyond the public job pages. Those genuinely require an authenticated session, and this
  server deliberately doesn't have one.
- **Risk differs by source, and it isn't uniform.**

  | Sources | Basis | Assessment |
  |---|---|---|
  | Greenhouse, Lever, Ashby | published APIs, no auth | lowest — built for this |
  | Remotive, RemoteOK | public JSON feeds | low — RemoteOK asks you to send contact info in the `User-Agent`; set `REMOTEOK_CONTACT` |
  | Computrabajo | public server-rendered HTML | moderate — public pages, still automated |
  | LinkedIn | public logged-out pages | moderate — undocumented, rate-limited, **automated access may conflict with LinkedIn's User Agreement** |

- **Not affiliated with, endorsed by, or connected to LinkedIn, Microsoft, Computrabajo or
  any ATS vendor.** LinkedIn is a trademark of LinkedIn Corporation.
- **Endpoints will change.** Already happened: `/jobs-guest/jobs/api/view/{id}` returned
  **404** and LinkedIn details moved to the public job page; Computrabajo's
  `/busqueda/?p=` also 404s. Expect selector rot; PRs welcome.
- **ATS coverage is per company.** If a company doesn't run on Greenhouse/Lever/Ashby, it
  won't be found there — pass `org` deliberately rather than assuming a name will work.
- **No warranty.** See `LICENSE`.

---

## Development

```bash
npm test                 # 31 offline tests: parsing, filtering, dedupe, protocol
npm start                # run the server on stdio (Ctrl-C to stop)
```

`npm test` never touches the network, so CI runs the same suite on Node 18, 20, 22 and 24
without any install step.

## License

[MIT](LICENSE) © Esteban Alonzo
