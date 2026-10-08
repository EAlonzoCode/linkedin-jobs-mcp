#!/usr/bin/env node
/**
 * LinkedIn Jobs MCP Server
 *
 * Searches public LinkedIn job postings through LinkedIn's *guest* endpoints —
 * the same HTML the logged-out Jobs page returns. No OAuth, no cookies, no
 * session: your LinkedIn account is never involved, so there is no account
 * risk. It also means no `send-message`, `connect`, or feed tools: those
 * genuinely require a logged-in session.
 *
 * stdout carries ONLY JSON-RPC (MCP stdio transport); diagnostics go to stderr.
 */

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
}

/** Minimum gap between requests — the guest endpoints are IP rate-limited. */
const MIN_GAP_MS = 600
let lastRequestAt = 0

function log(...args) {
  process.stderr.write(`[${new Date().toISOString()}] ${args.join(' ')}\n`)
}

async function politeFetch(url) {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now()
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()

  const res = await fetch(url, { headers: HEADERS })
  const body = await res.text()

  if (!res.ok) {
    const err = new Error(
      `LinkedIn responded with ${res.status} for ${url.replace(/^https?:\/\/[^/]+/, '')}`
    )
    err.status = res.status
    throw err
  }
  return body
}

// ---------------------------------------------------------------------------
// HTML helpers (no parser dependency — the guest markup is stable and flat)
// ---------------------------------------------------------------------------

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

/** Strips tags, collapses whitespace, decodes entities. */
function text(html) {
  if (!html) return ''
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|div|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function match(html, re) {
  const m = html.match(re)
  return m ? m[1] : ''
}

function matchAll(html, re) {
  return [...html.matchAll(re)]
}

/** Normalises LinkedIn's permalink down to a bare numeric job id. */
function extractJobId(input) {
  if (/^\d{6,}$/.test(input)) return input
  const urn = input.match(/jobPosting:(\d+)/)
  if (urn) return urn[1]
  const view = input.match(/\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})(?:[/?#]|$)/)
  if (view) return view[1]
  const digits = input.match(/(\d{9,})/)
  return digits ? digits[1] : ''
}

// ---------------------------------------------------------------------------
// LinkedIn guest endpoints
// ---------------------------------------------------------------------------

/**
 * Lists postings for a keyword/location pair.
 * @returns {Promise<Array<object>>}
 */
async function searchJobs({ keywords, location = '', page = 0, start, limit = 25 }) {
  const offset = typeof start === 'number' ? start : page * 25
  const params = new URLSearchParams({
    keywords,
    location,
    trk: 'public_jobs_jobs-search-bar_search-submit',
    position: '1',
    pageNum: String(page),
    start: String(offset)
  })

  const html = await politeFetch(
    `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`
  )

  if (!html.includes('jobPosting:')) {
    log(`search returned no cards (bytes=${html.length})`)
    return []
  }

  // Each card owns exactly one entity-URN, so splitting on it yields one chunk per job.
  const chunks = html.split(/(?=data-entity-urn="urn:li:jobPosting:)/).slice(1)

  return chunks.slice(0, limit).map((chunk) => {
    const id = match(chunk, /data-entity-urn="urn:li:jobPosting:(\d+)"/)
    const url = match(chunk, /class="base-card__full-link[^"]*"\s+href="([^"]+)"/)

    const job = {
      id,
      title: text(match(chunk, /<h3 class="base-search-card__title">([\s\S]*?)<\/h3>/)),
      company: text(match(chunk, /<h4 class="base-search-card__subtitle">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)),
      location: text(match(chunk, /<span class="job-search-card__location">([\s\S]*?)<\/span>/)),
      postedAt: match(chunk, /<time[^>]*datetime="([^"]+)"/) || undefined,
      url: decodeEntities(url) || (id ? `https://www.linkedin.com/jobs/view/${id}` : '')
    }

    const note = text(
      match(chunk, /<span class="job-posting-benefits__text">([\s\S]*?)<\/span>/)
    )
    if (note) job.note = note

    return job
  })
}

/**
 * Fetches the full description + hiring criteria for one posting.
 *
 * Uses the public (logged-out) job page. The older
 * `/jobs-guest/jobs/api/view/{id}` endpoint now returns 404.
 */
async function getJobDetails({ jobId }) {
  const id = extractJobId(jobId)
  if (!id) throw new Error(`Could not extract a job id from "${jobId}"`)

  const html = await politeFetch(`https://www.linkedin.com/jobs/view/${id}`)

  const job = {
    id,
    title: text(match(html, /<h1[^>]*class="[^"]*top-card-layout__title[^"]*"[^>]*>([\s\S]*?)<\/h1>/)),
    company: text(match(html, /<a[^>]*class="[^"]*topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\/a>/)),
    location: text(match(html, /<span class="topcard__flavor topcard__flavor--bullet">([\s\S]*?)<\/span>/)),
    description: text(
      match(html, /<div class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    ),
    criteria: [],
    url: `https://www.linkedin.com/jobs/view/${id}`
  }

  // Criteria come as two parallel class lists (subheaders and values), so zip them.
  const labels = [...html.matchAll(/<h3 class="description__job-criteria-subheader[^"]*"[^>]*>([\s\S]*?)<\/h3>/g)]
    .map((m) => text(m[1]))
  const values = [...html.matchAll(/<span class="description__job-criteria-text[^"]*"[^>]*>([\s\S]*?)<\/span>/g)]
    .map((m) => text(m[1]))
  for (let i = 0; i < Math.max(labels.length, values.length); i++) {
    if (labels[i] || values[i]) job.criteria.push({ label: labels[i] ?? '', value: values[i] ?? '' })
  }

  const applicants = text(match(html, /<span class="[^"]*num-applicants__caption[^"]*"[^>]*>([\s\S]*?)<\/span>/))
  if (applicants) job.applicants = applicants

  const postedRelative = text(
    match(html, /<span class="[^"]*posted-time-ago__text[^"]*"[^>]*>([\s\S]*?)<\/span>/)
  )
  if (postedRelative) job.postedRelative = postedRelative

  const postedAt = match(html, /<time[^>]*datetime="([^"]+)"/)
  if (postedAt) job.postedAt = postedAt

  if (/Solicitud sencilla|Easy Apply/i.test(html)) job.easyApply = true

  if (!job.title && !job.description) {
    throw new Error(`Job ${id} is no longer posted, or it is private.`)
  }

  return job
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'search-jobs',
    description:
      'Search LinkedIn job postings via the public guest endpoints (no login, your account is never involved). ' +
      'Returns id, title, company, location, posting date and URL. ' +
      'Use `start` to paginate (each page returns up to 25 results). ' +
      'For the full description of a posting, call `get-job-details` afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: {
          type: 'string',
          description:
            'Job keywords, e.g. "Data Analyst" or "junior data analyst" or "analista de datos junior"'
        },
        location: {
          type: 'string',
          description:
            'City or region, e.g. "Santiago, Chile". Optional; leave empty for any location.'
        },
        start: {
          type: 'number',
          description: 'Pagination offset (0, 25, 50, ...). Defaults to 0.'
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (1-50). Defaults to 25.'
        }
      },
      required: ['keywords']
    }
  },
  {
    name: 'get-job-details',
    description:
      'Full description of a single job posting, including hiring criteria (seniority, employment type, ' +
      'schedule, sectors), applicant count and whether it offers Easy Apply. ' +
      'Accepts either the full job URL or the numeric id returned by `search-jobs`. ' +
      'Use this to compare a posting against a CV or a set of requirements.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description:
            'Job posting URL (https://www.linkedin.com/jobs/view/...) or numeric id.'
        }
      },
      required: ['jobId']
    }
  }
]

// ---------------------------------------------------------------------------
// MCP stdio transport (newline-delimited JSON-RPC)
// ---------------------------------------------------------------------------

const SERVER_INFO = { name: 'linkedin-jobs', version: '1.0.0' }

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function callTool(name, args) {
  if (name === 'search-jobs') {
    if (!args?.keywords?.trim()) throw new Error('`keywords` is required.')
    const jobs = await searchJobs({
      keywords: args.keywords.trim(),
      location: (args.location ?? '').trim(),
      start: typeof args.start === 'number' ? args.start : 0,
      limit: Math.min(Math.max(args.limit ?? 25, 1), 50)
    })
    // Wrapped in an object: MCP `structuredContent` must be a record, not an array.
    return { count: jobs.length, start: typeof args.start === 'number' ? args.start : 0, jobs }
  }

  if (name === 'get-job-details') {
    if (!args?.jobId) throw new Error('`jobId` is required.')
    return await getJobDetails({ jobId: String(args.jobId).trim() })
  }

  throw new Error(`Unknown tool: ${name}`)
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
    const name = params?.name
    try {
      const result = await callTool(name, params?.arguments ?? {})
      const isRecord =
        typeof result === 'object' && result !== null && !Array.isArray(result)
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        // Optional, but when present MCP requires an object rather than an array.
        ...(isRecord ? { structuredContent: result } : {})
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`tools/call ${name} failed: ${message}`)
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

log(`linkedin-jobs MCP ready (pid=${process.pid})`)
