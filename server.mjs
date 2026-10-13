#!/usr/bin/env node
/**
 * Multi-source job search MCP server.
 *
 * Talks MCP over stdio (newline-delimited JSON-RPC) with no SDK. Sources live
 * in `sources/`, one file per job board, and register themselves in
 * `core/registry.js`; this file only wires the transport to that registry.
 *
 * stdout carries ONLY JSON-RPC. Diagnostics go to stderr, because a log line
 * on stdout corrupts the stream and clients disconnect with "Connection closed".
 */

import { SOURCES, getSource, searchableSources } from './core/registry.js'
import { mapLimit } from './core/http.js'
import { dedupe } from './core/dedupe.js'
import { log } from './core/log.js'

const SERVER_INFO = { name: 'linkedin-jobs', version: '2.0.0' }

/** Per-request ceiling so one slow source cannot stall an aggregate search. */
const SOURCE_TIMEOUT_MS = 12000

/**
 * Fields kept in a summary payload. Descriptions are the expensive part of any
 * job listing, so they are opt-in via `fields: "full"` rather than the default.
 */
const SUMMARY_FIELDS = [
  'source',
  'id',
  'title',
  'company',
  'location',
  'url',
  'postedAt',
  'salary',
  'sources'
]

/** Drops everything a summary reader does not need. */
function project(job, fields) {
  if (fields === 'full') return job
  const out = {}
  for (const key of SUMMARY_FIELDS) {
    const value = job[key]
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const PAGING = {
  start: { type: 'number', description: 'Offset for pagination. Defaults to 0.' },
  limit: { type: 'number', description: 'Max results, 1-50. Defaults to 25.' },
  fields: {
    type: 'string',
    enum: ['summary', 'full'],
    description: '"summary" (default) omits descriptions to save tokens. "full" includes them.'
  }
}

const ATS = {
  org: {
    type: 'string',
    description: 'Company slug on that ATS board, e.g. "airbnb" for Greenhouse, "notion" for Ashby.'
  },
  keywords: { type: 'string', description: 'Keywords matched against title, company and description.' },
  location: { type: 'string', description: 'Substring matched against the job location. Optional.' },
  limit: PAGING.limit,
  fields: PAGING.fields
}

const KEYWORDS_ONLY = {
  keywords: { type: 'string', description: 'Search keywords, e.g. "data engineer python".' },
  location: { type: 'string', description: 'City or region, e.g. "Santiago, Chile". Optional.' },
  start: PAGING.start,
  limit: PAGING.limit,
  fields: PAGING.fields
}

function searchToolSchema(source) {
  if (source.needsOrg) {
    return { type: 'object', properties: { ...ATS }, required: ['org'] }
  }
  const props = { ...KEYWORDS_ONLY }
  // Boards without a keyword search still accept one as optional.
  if (source.optionalKeywords) delete props.keywords
  return {
    type: 'object',
    properties: props,
    required: source.optionalKeywords ? [] : ['keywords']
  }
}

const TOOLS = [
  {
    name: 'search-all',
    description:
      'Searches several job boards at once and de-duplicates the results. Recommended first call. ' +
      'Returns compact rows only (title/company/location/url) — use `get-job-details` for the full text. ' +
      'Sources: ' +
      searchableSources()
        .map((s) => s.id)
        .join(', ') +
      '.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: 'Search keywords, e.g. "backend python".' },
        location: { type: 'string', description: 'City or region, e.g. "Santiago, Chile". Optional.' },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict to specific sources. Omit to search all of them.'
        },
        perSource: {
          type: 'number',
          description: 'Max results kept per source. Defaults to 5 — keep it low, this is a summary.'
        },
        maxResults: { type: 'number', description: 'Total cap after de-duplication. Defaults to 30.' }
      },
      required: ['keywords']
    }
  },
  ...searchableSources().map((source) => ({
    name: `search-${source.id}`,
    description: `${source.name}: ${source.blurb}`,
    inputSchema: searchToolSchema(source)
  })),
  {
    name: 'get-job-details',
    description:
      'Fetches the full description of one posting. `source` plus `id` is enough; ' +
      'Greenhouse and Lever also need `org`.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          enum: SOURCES.map((s) => s.id),
          description: 'Which board the job came from.'
        },
        id: { type: 'string', description: 'Job id as returned by the search tools.' },
        org: { type: 'string', description: 'Required only for greenhouse and lever.' }
      },
      required: ['source', 'id']
    }
  }
]

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function clamp(value, fallback, max) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback
}

async function runSearch(source, args) {
  const started = Date.now()
  try {
    const result = await Promise.race([
      source.search(args),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${source.id} timed out after ${SOURCE_TIMEOUT_MS}ms`)), SOURCE_TIMEOUT_MS)
      )
    ])
    const jobs = (result?.jobs ?? []).map((job) => ({ ...job, source: source.id }))
    return { source: source.id, ok: true, ms: Date.now() - started, count: result?.count, jobs }
  } catch (error) {
    return { source: source.id, ok: false, error: error.message, jobs: [] }
  }
}

async function searchAll(args) {
  const perSource = clamp(args.perSource, 5, 25)
  const maxResults = clamp(args.maxResults, 30, 100)

  const wanted = args.sources?.length
    ? args.sources.map((id) => getSource(id))
    : searchableSources()

  // Sources that need a company slug cannot be searched blind.
  const runnable = wanted.filter((s) => !s.needsOrg)
  const skipped = wanted.filter((s) => s.needsOrg).map((s) => s.id)

  const settled = await mapLimit(runnable, 4, (source) =>
    runSearch(source, { ...args, start: 0, limit: perSource, fields: 'summary' })
  )

  // mapLimit reports { ok, value }. runSearch already produces a ready-made
  // per-source report, so unwrap the successes and flatten the failures.
  const reports = settled.map((r) =>
    r.ok
      ? r.value
      : { source: r.source, ok: false, error: r.error?.message ?? String(r.error), jobs: [] }
  )

  const merged = dedupe(reports.flatMap((r) => r.jobs)).slice(0, maxResults)

  return {
    count: merged.length,
    sources: reports.map((r) =>
      r.ok
        ? { source: r.source, ok: true, returned: r.jobs.length, total: r.count, ms: r.ms }
        : { source: r.source, ok: false, error: r.error }
    ),
    ...(skipped.length
      ? { skipped: `${skipped.join(', ')} need an "org" (company slug) — use their own tool.` }
      : {}),
    jobs: merged.map((job) => project(job, 'summary'))
  }
}

async function callTool(name, args) {
  if (name === 'search-all') {
    if (!args?.keywords?.trim()) throw new Error('`keywords` is required.')
    return searchAll(args)
  }

  if (name === 'get-job-details') {
    const source = getSource(args.source)
    if (!source.details) throw new Error(`Source "${source.id}" does not support details.`)
    return source.details({ id: args.id, org: args.org })
  }

  if (name.startsWith('search-')) {
    const source = getSource(name.slice('search-'.length))
    const fields = args.fields ?? 'summary'
    const result = await runSearch(source, { ...args, limit: clamp(args.limit, 25, 50), fields })
    if (!result.ok) throw new Error(result.error)
    return {
      source: result.source,
      count: result.count ?? result.jobs.length,
      jobs: result.jobs.map((job) => project(job, fields))
    }
  }

  throw new Error(`Unknown tool: ${name}`)
}

// ---------------------------------------------------------------------------
// MCP stdio transport (newline-delimited JSON-RPC)
// ---------------------------------------------------------------------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    log(`discarded non-JSON input: ${line.slice(0, 120)}`)
    return
  }

  const { id, method, params } = msg

  // Notifications carry no id and require no response.
  if (id === undefined || id === null) return

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO
    })
    return
  }

  if (method === 'ping') {
    reply(id, {})
    return
  }

  if (method === 'tools/list') {
    reply(id, { tools: TOOLS })
    return
  }

  if (method === 'tools/call') {
    const toolName = params?.name
    try {
      const result = await callTool(toolName, params?.arguments ?? {})
      const isRecord = typeof result === 'object' && result !== null && !Array.isArray(result)
      // Aggregated lists are compact; a single job detail is worth reading formatted.
      const pretty = toolName === 'get-job-details'
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, pretty ? 2 : 0) }],
        ...(isRecord ? { structuredContent: result } : {})
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`tools/call ${toolName} failed: ${message}`)
      reply(id, {
        isError: true,
        content: [{ type: 'text', text: `Error: ${message}` }]
      })
    }
    return
  }

  // Optional capabilities some clients probe for.
  if (method === 'resources/list' || method === 'prompts/list') {
    reply(id, method === 'resources/list' ? { resources: [] } : { prompts: [] })
    return
  }

  replyError(id, -32601, `Unsupported method: ${method}`)
}

// ---------------------------------------------------------------------------
// Wire-up
// ---------------------------------------------------------------------------

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) void handle(line)
  }
})

process.stdin.on('end', () => process.exit(0))
process.on('EPIPE', () => process.exit(0))
process.on('uncaughtException', (err) => {
  log(`uncaught: ${err?.stack ?? err}`)
})

log(`job-search MCP ready v${SERVER_INFO.version} (pid=${process.pid}) sources=${SOURCES.map((s) => s.id).join(',')}`)
