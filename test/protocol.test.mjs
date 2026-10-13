/**
 * Offline tests.
 *
 * Part 1 drives the real MCP handshake over stdio, so `npm test` needs no
 * network and stays deterministic. Part 2 exercises the pure helpers that the
 * sources depend on — parsing, filtering, de-duplication — which are exactly
 * the parts that break silently when a site changes its markup.
 *
 * The invariant worth protecting is the one that bit us during development:
 * stdout must carry ONLY JSON-RPC. A stray log line on stdout makes MCP
 * clients disconnect with "Connection closed".
 *
 * Everything runs inside one outer test with nested subtests, so the child
 * process lives for the whole run and the root suite can't finish early.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SOURCES, getSource, searchableSources } from '../core/registry.js'
import { mapLimit } from '../core/http.js'
import { decodeEntities, text } from '../core/html.js'
import { dedupe, normalize, jobKey, similarity } from '../core/dedupe.js'
import { matchesKeywords, matchesLocation, filterJobs } from '../core/filter.js'
import { slugify } from '../sources/computrabajo.js'
import { extractJobId } from '../sources/linkedin.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// Expected tool surface — changing this list is an API change for clients.
// ---------------------------------------------------------------------------

const PER_SOURCE_TOOLS = searchableSources().map((s) => `search-${s.id}`).sort()
const ALL_TOOLS = [...PER_SOURCE_TOOLS, 'search-all', 'get-job-details'].sort()

test('pure helpers', async (t) => {
  await t.test('decodeEntities handles decimal and hex entities', () => {
    assert.equal(decodeEntities('gesti&#xF3;n &amp; an&#xE1;lisis'), 'gestión & análisis')
    assert.equal(decodeEntities('M&#233;xico &lt;b&gt;'), 'México <b>')
  })

  await t.test('text() strips tags, keeping paragraph breaks as blank lines', () => {
    assert.equal(text('<p>  Hola  </p>\n<p>mundo</p>'), 'Hola\n\nmundo')
    assert.equal(text('<li>uno</li><li>dos</li>'), 'uno\ndos')
    assert.equal(text('<b>sin</b> etiquetas'), 'sin etiquetas')
    assert.equal(text(''), '')
  })

  await t.test('matchesKeywords uses AND semantics and is case-insensitive', () => {
    assert.ok(matchesKeywords('Senior Python Engineer', 'python senior'))
    assert.ok(!matchesKeywords('Senior Python Engineer', 'python java'))
    assert.ok(matchesKeywords('anything', ''), 'an empty query should match everything')
  })

  await t.test('matchesLocation tolerates empty inputs on both sides', () => {
    assert.ok(matchesLocation('Santiago, Chile', 'santiago'))
    assert.ok(matchesLocation('', ''))
    assert.ok(!matchesLocation('Lima', 'santiago'))
  })

  await t.test('filterJobs narrows on title, company and description', () => {
    const jobs = [
      { title: 'Data Engineer', company: 'Acme', location: 'Santiago' },
      { title: 'Account Manager', company: 'Beta', location: 'Lima' },
      { title: 'Software Engineer', company: 'Gamma', location: 'Madrid', description: 'Python' }
    ]
    assert.equal(filterJobs(jobs, { keywords: 'python' }).length, 1)
    assert.equal(filterJobs(jobs, { keywords: 'engineer' }).length, 2)
    assert.equal(filterJobs(jobs, { location: 'santiago' }).length, 1)
    assert.equal(filterJobs(jobs, {}).length, 3)
  })

  await t.test('normalize drops accents, punctuation and stopwords', () => {
    // Stopwords and rank prefixes are what make two listings of the same role
    // look different, so they are stripped before building a de-dupe key.
    assert.deepEqual(normalize('Ingeniero/a de Datos – JR'), ['ingeniero', 'datos'])
    assert.deepEqual(normalize('Sr. Backend Developer'), ['backend', 'developer'])
    assert.deepEqual(normalize('  '), [])
  })

  await t.test('dedupe merges identical roles and keeps every source', () => {
    const merged = dedupe([
      { title: 'Data Engineer', company: 'Acme', source: 'linkedin', id: '1' },
      { title: 'Data  Engineer!', company: 'acme', source: 'computrabajo', id: '2', salary: '$1' },
      { title: 'Data Engineer', company: 'Other', source: 'linkedin', id: '3' }
    ])
    assert.equal(merged.length, 2, 'distinct companies must not be merged')
    const acme = merged.find((j) => j.company === 'Acme')
    assert.deepEqual(acme.sources, ['linkedin', 'computrabajo'])
    assert.equal(acme.salary, '$1', 'the merged copy should inherit the richer payload')
  })

  await t.test('jobKey is stable across formatting differences', () => {
    assert.equal(jobKey({ title: 'Sr. Backend Dev', company: 'Naranja' }),
                 jobKey({ title: 'SR backend dev', company: 'NARANJA' }))
    assert.notEqual(jobKey({ title: 'Dev A', company: 'X' }), jobKey({ title: 'Dev B', company: 'X' }))
  })

  await t.test('similarity behaves like Jaccard', () => {
    assert.equal(similarity(['a', 'b'], ['a', 'b']), 1)
    assert.equal(similarity(['a'], ['b']), 0)
    assert.ok(similarity(['a', 'b'], ['b', 'c']) > 0 && similarity(['a', 'b'], ['b', 'c']) < 1)
    assert.equal(similarity([], ['a']), 0)
  })

  await t.test('computrabajo slugify strips accents and punctuation', () => {
    assert.equal(slugify('Data Engineer'), 'data-engineer')
    assert.equal(slugify('Ingeniero/a de Datos'), 'ingeniero-a-de-datos')
    assert.equal(slugify('  análisis  '), 'analisis')
  })

  await t.test('linkedin extractJobId accepts id, urn and permalinks', () => {
    assert.equal(extractJobId('4472786436'), '4472786436')
    assert.equal(extractJobId('urn:li:jobPosting:4472786436'), '4472786436')
    assert.equal(
      extractJobId('https://cl.linkedin.com/jobs/data-engineer-job-imagemaker-4472786436'),
      '4472786436'
    )
    assert.equal(extractJobId('not-a-job'), '')
  })

  await t.test('every source honours the registry contract', async () => {
    const seen = new Set()
    for (const source of SOURCES) {
      assert.ok(typeof source.id === 'string' && /^[a-z]+$/.test(source.id), `${source.id}: bad id`)
      assert.ok(!seen.has(source.id), `duplicate source id ${source.id}`)
      seen.add(source.id)
      assert.ok(typeof source.name === 'string' && source.name.length > 0, `${source.id}: no name`)
      assert.ok(typeof source.blurb === 'string' && source.blurb.length > 0, `${source.id}: no blurb`)
      assert.equal(typeof source.search, 'function', `${source.id}: search() missing`)
      if (source.needsOrg) {
        assert.ok(
          await rejectsWithoutOrg(source),
          `${source.id} is marked needsOrg but did not demand one`
        )
      }
    }
  })

  await t.test('getSource rejects an unknown id with the valid list', () => {
    assert.throws(() => getSource('monster'), /Unknown source.*greenhouse/)
  })

  await t.test('every keyword source rejects an empty query before any network call', async () => {
    // The schema marks `keywords` required. If the implementation disagrees,
    // the model gets a silent "all jobs" dump instead of a clear error.
    for (const source of searchableSources()) {
      if (source.needsOrg || source.optionalKeywords) continue
      await assert.rejects(
        () => source.search({}),
        /`keywords` is required/,
        `search-${source.id} accepted an empty query but its schema requires keywords`
      )
    }
  })

  await t.test('mapLimit preserves order, values and source ids', async () => {
    // Regression: the aggregate search once read `r.jobs` on a wrapper that
    // actually stores the result under `r.value`, so every source yielded
    // `undefined` and search-all crashed with "reading 'title'".
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const settled = await mapLimit(items, 2, (item) => Promise.resolve(`${item.id}-ok`))

    assert.equal(settled.length, items.length, 'every slot must be filled, no holes')
    assert.deepEqual(settled.map((r) => r.ok), [true, true, true])
    assert.deepEqual(settled.map((r) => r.value), ['a-ok', 'b-ok', 'c-ok'])
    assert.deepEqual(settled.map((r) => r.source), ['a', 'b', 'c'], 'source id lost')
    assert.ok(settled.every((r) => r.value !== undefined), 'value must not be undefined')
  })

  await t.test('mapLimit isolates a failing item instead of rejecting the batch', async () => {
    const settled = await mapLimit([{ id: 'good' }, { id: 'bad' }, { id: 'good2' }], 3, (item) =>
      item.id === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(item.id)
    )
    assert.deepEqual(settled.map((r) => r.ok), [true, false, true])
    assert.equal(settled[1].error.message, 'boom')
    assert.equal(settled[1].source, 'bad')
    assert.equal(settled[2].value, 'good2')
  })

  await t.test('mapLimit bounds concurrency', async () => {
    let live = 0
    let peak = 0
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 5))
      live--
    })
    assert.ok(peak <= 2, `concurrency peaked at ${peak}, expected <= 2`)
    assert.ok(peak >= 2, 'the limit should actually be used')
  })
})

async function rejectsWithoutOrg(source) {
  try {
    await source.search({})
    return false
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

test('job-search MCP server', async (t) => {
  const child = spawn(process.execPath, [resolve(ROOT, 'server.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  const pending = new Map()
  const stdoutLines = []

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    let nl
    while ((nl = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, nl)
      stdout = stdout.slice(nl + 1)
      if (!line.trim()) continue
      stdoutLines.push(line)
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = pending.get(msg.id)
      if (waiter) {
        pending.delete(msg.id)
        waiter(msg)
      }
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  function request(id, method, params) {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rej(new Error(`timeout waiting for response to ${method}\nstderr: ${stderr}`))
      }, 10000)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        res(msg)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  function notify(method) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
  }

  try {
    // --- handshake -------------------------------------------------------
    const initialize = await request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke-test', version: '1.0.0' }
    })

    await t.test('initialize returns the expected server info', () => {
      assert.equal(initialize.jsonrpc, '2.0')
      assert.equal(initialize.result.serverInfo.name, 'linkedin-jobs')
      assert.equal(initialize.result.serverInfo.version, '2.0.0')
      assert.ok(initialize.result.capabilities.tools, 'tools capability missing')
    })

    // Clients block until this arrives.
    notify('notifications/initialized')

    // --- transport -------------------------------------------------------
    const ping = await request(2, 'ping', {})
    await t.test('ping responds', () => {
      assert.equal(ping.id, 2)
      assert.equal(ping.jsonrpc, '2.0')
      assert.deepEqual(ping.result, {})
    })

    const resources = await request(3, 'resources/list', {})
    await t.test('resources/list returns an empty collection', () => {
      assert.equal(resources.error, undefined)
      assert.deepEqual(resources.result, { resources: [] })
    })

    const prompts = await request(4, 'prompts/list', {})
    await t.test('prompts/list returns an empty collection', () => {
      assert.equal(prompts.error, undefined)
      assert.deepEqual(prompts.result, { prompts: [] })
    })

    const unsupported = await request(5, 'completion/complete', {})
    await t.test('unknown methods return -32601 instead of crashing', () => {
      assert.ok(unsupported.error, 'expected an error object')
      assert.equal(unsupported.error.code, -32601)
    })

    // --- tool surface ----------------------------------------------------
    const tools = await request(6, 'tools/list', {})
    const byName = new Map(tools.result.tools.map((x) => [x.name, x]))

    await t.test('tools/list exposes search-all, get-job-details and one tool per source', () => {
      assert.deepEqual([...byName.keys()].sort(), ALL_TOOLS)
      // A tool per source, not a hardcoded list: adding a file in sources/
      // must surface here without touching server.mjs.
      for (const source of searchableSources()) {
        assert.ok(byName.has(`search-${source.id}`), `missing search-${source.id}`)
      }
    })

    await t.test('search-all is the recommended entry point', () => {
      const tool = byName.get('search-all')
      assert.ok(tool.description.length > 0)
      assert.deepEqual(tool.inputSchema.required, ['keywords'])
      for (const key of ['location', 'sources', 'perSource', 'maxResults']) {
        assert.ok(tool.inputSchema.properties[key], `search-all missing ${key}`)
      }
      for (const source of searchableSources()) {
        assert.ok(tool.description.includes(source.id), `search-all should list ${source.id}`)
      }
    })

    await t.test('keyword sources require keywords', () => {
      for (const source of searchableSources()) {
        if (source.needsOrg || source.optionalKeywords) continue
        const tool = byName.get(`search-${source.id}`)
        assert.deepEqual(tool.inputSchema.required, ['keywords'], `search-${source.id}`)
      }
    })

    await t.test('ATS tools require org instead of keywords', () => {
      for (const source of searchableSources().filter((s) => s.needsOrg)) {
        const tool = byName.get(`search-${source.id}`)
        assert.deepEqual(tool.inputSchema.required, ['org'], `search-${source.id}`)
        assert.ok(tool.inputSchema.properties.org.description, `${source.id}: org undocumented`)
      }
    })

    await t.test('every search tool offers the fields opt-in that saves tokens', () => {
      for (const name of ALL_TOOLS.filter((n) => n.startsWith('search-'))) {
        const props = byName.get(name).inputSchema.properties
        if (name === 'search-all') continue // summaries only by design
        assert.ok(props.fields, `${name} missing fields`)
        assert.deepEqual(props.fields.enum, ['summary', 'full'])
      }
    })

    await t.test('get-job-details declares its params', () => {
      const tool = byName.get('get-job-details')
      assert.ok(tool.description.length > 0)
      assert.deepEqual(tool.inputSchema.required, ['source', 'id'])
      // The enum must stay in sync with the registry, or a job that a search
      // tool just returned becomes unfetchable.
      assert.deepEqual(
        [...tool.inputSchema.properties.source.enum].sort(),
        SOURCES.map((s) => s.id).sort()
      )
    })

    // --- the invariant that broke us once --------------------------------
    await t.test('stdout carries only valid JSON-RPC responses', () => {
      assert.ok(stdoutLines.length >= 4, 'expected several messages on stdout')
      for (const line of stdoutLines) {
        // JSON.parse throwing here == a log leaking onto the transport.
        const msg = JSON.parse(line)
        assert.equal(msg.jsonrpc, '2.0')
        assert.ok(msg.id === undefined || typeof msg.id === 'number')
        assert.ok(
          msg.result !== undefined || msg.error !== undefined,
          'expected a result or an error on stdout'
        )
      }
    })
  } finally {
    if (child.exitCode === null) child.kill()
  }
})
