/**
 * Lever — the other major ATS vendor alongside Greenhouse.
 *
 * `api.lever.co/v0/postings/{org}?mode=json` is Lever's published public board
 * API. Unlike Greenhouse it returns the full posting, description included,
 * in a single call — so details come free with the search.
 *
 * Lever returns every open role for the company at once, which is why the
 * keyword filter matters: a large employer can have several hundred.
 */
import { fetchJson } from '../core/http.js'
import { filterJobs } from '../core/filter.js'

const API = 'https://api.lever.co/v0/postings'

export default {
  id: 'lever',
  name: 'Lever',
  blurb: 'Lever ATS. Requires `org` (the slug in jobs.lever.co/{org}).',
  needsOrg: true,

  async search({ org, keywords = '', location = '', limit = 25 } = {}) {
    if (!org) {
      throw new Error('`org` is required: the slug in the company\'s Lever board, e.g. "leverdemo".')
    }

    const postings = await fetchJson(`${API}/${encodeURIComponent(org.trim())}?mode=json`)

    const jobs = (Array.isArray(postings) ? postings : []).map((p) => ({
      id: String(p.id),
      source: 'lever',
      title: String(p.text ?? '').trim(),
      company: org.trim(),
      location: p.categories?.location ?? '',
      url: p.hostedUrl,
      department: p.categories?.department || undefined,
      team: p.categories?.team || undefined,
      commitment: p.categories?.commitment || undefined,
      postedAt: p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : undefined,
      description: p.descriptionPlain || undefined
    }))

    const filtered = filterJobs(jobs, { keywords, location })
    return { count: filtered.length, jobs: filtered.slice(0, limit) }
  },

  /** Same payload as search — Lever ships the description inline. */
  async details({ org, id } = {}) {
    if (!org) throw new Error('`org` is required for Lever details.')
    const postings = await fetchJson(`${API}/${encodeURIComponent(org.trim())}?mode=json`)
    const found = (Array.isArray(postings) ? postings : []).find((p) => String(p.id) === String(id))
    if (!found) throw new Error(`Posting ${id} not found on the "${org}" Lever board.`)

    return {
      id: String(found.id),
      source: 'lever',
      title: String(found.text ?? '').trim(),
      company: org.trim(),
      location: found.categories?.location ?? '',
      url: found.hostedUrl,
      department: found.categories?.department || undefined,
      postedAt: found.createdAt ? new Date(found.createdAt).toISOString().slice(0, 10) : undefined,
      description: found.descriptionPlain || ''
    }
  }
}
