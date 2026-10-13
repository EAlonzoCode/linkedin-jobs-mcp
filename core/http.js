/**
 * Shared HTTP plumbing: per-host rate limiting, timeouts, and text/JSON fetches.
 *
 * Two tiers of restraint:
 *  - Scraped guest pages (LinkedIn, Computrabajo) get a real pause, because
 *    they are IP rate-limited and undocumented.
 *  - Official ATS APIs are free to call quickly. They are published precisely
 *    so people build on them, so there is nothing to throttle aggressively.
 *
 * Do NOT add proxy rotation or fingerprint spoofing here. That is the line
 * between a tool people can run and a tool that gets blocked for everyone.
 */
import { log } from './log.js'

const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'es-CL,es;q=0.9,en;q=0.8'
}

/** Minimum gap between requests, per host. */
const HOST_GAP_MS = {
  'www.linkedin.com': 600, // undocumented guest endpoints, aggressively limited
  'cl.computrabajo.com': 400 // server-rendered but still a real site
}
const DEFAULT_GAP_MS = 60

const lastHitAt = new Map()

async function waitTurn(host) {
  const gap = HOST_GAP_MS[host] ?? DEFAULT_GAP_MS
  const remaining = (lastHitAt.get(host) ?? 0) + gap - Date.now()
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining))
  lastHitAt.set(host, Date.now())
}

/**
 * Fetches a URL.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {object} [opts.headers]  extra headers merged over the defaults
 * @param {number} [opts.timeout]  ms before aborting (default 15000)
 * @param {'text'|'json'} [opts.as]
 * @param {string} [opts.method]
 * @param {string} [opts.body]
 * @returns {Promise<string|any>}
 */
export async function fetchUrl(url, opts = {}) {
  const { headers = {}, timeout = 15000, as = 'text', method, body } = opts
  const host = new URL(url).host

  await waitTurn(host)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  let res
  try {
    res = await fetch(url, {
      method,
      body,
      headers: { ...BASE_HEADERS, ...headers },
      signal: controller.signal
    })
  } catch (err) {
    const reason = err?.name === 'AbortError' ? `timeout after ${timeout}ms` : err?.message
    throw new Error(`${host}: ${reason}`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const err = new Error(`${host} responded with ${res.status} for ${new URL(url).pathname}`)
    err.status = res.status
    throw err
  }

  return as === 'json' ? res.json() : res.text()
}

/** Convenience: JSON with a friendly error prefix. */
export function fetchJson(url, opts = {}) {
  return fetchUrl(url, { ...opts, as: 'json' })
}

/** Runs `jobs` with a bounded concurrency, collecting settled results. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let cursor = 0

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      const source = items[i]?.id ?? items[i]
      try {
        out[i] = { ok: true, value: await fn(items[i], i), source }
      } catch (error) {
        out[i] = { ok: false, error, source }
        log(`source ${source ?? '?'} failed: ${error.message}`)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
