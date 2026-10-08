/**
 * Offline protocol smoke test.
 *
 * Spawns server.mjs over stdio and drives the MCP handshake plus tools/list.
 * No network: it never calls LinkedIn, so `npm test` is fast and deterministic.
 *
 * The invariant worth protecting here is the one that actually bit us during
 * development: stdout must carry ONLY JSON-RPC. A stray log line on stdout
 * makes MCP clients disconnect with "Connection closed".
 *
 * Everything runs inside one outer test with nested subtests, so the child
 * process lives for the whole run and the root suite can't finish early.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('linkedin-jobs MCP server', async (t) => {
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
      assert.equal(initialize.result.serverInfo.version, '1.0.0')
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

    await t.test('tools/list exposes exactly search-jobs and get-job-details', () => {
      assert.deepEqual(
        tools.result.tools.map((x) => x.name).sort(),
        ['get-job-details', 'search-jobs']
      )
    })

    await t.test('search-jobs declares its params', () => {
      const tool = tools.result.tools.find((x) => x.name === 'search-jobs')
      assert.ok(tool.description.length > 0)
      assert.deepEqual(tool.inputSchema.required, ['keywords'])
      assert.ok(tool.inputSchema.properties.location)
      assert.ok(tool.inputSchema.properties.start)
      assert.ok(tool.inputSchema.properties.limit)
    })

    await t.test('get-job-details declares its params', () => {
      const tool = tools.result.tools.find((x) => x.name === 'get-job-details')
      assert.ok(tool.description.length > 0)
      assert.deepEqual(tool.inputSchema.required, ['jobId'])
      assert.ok(tool.inputSchema.properties.jobId.description)
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
