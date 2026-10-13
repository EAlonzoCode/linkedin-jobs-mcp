/**
 * Greenhouse — one of the two most common ATS vendors.
 *
 * `boards-api.greenhouse.io` is Greenhouse's published, unauthenticated public
 * board API. It exists specifically so people can build on it, which makes
 * this the lowest-risk source in the project.
 *
 * Boards are per company, so `org` is required: it is the slug in the board
 * URL, e.g. `airbnb` in careers.airbnb.com.
 */
import { fetchJson } from '../core/http.js'
import { filterJobs } from '../core/filter.js'
import { text } from '../core/html.js'

const API = 'https://boards-api.greenhouse.io/v1/boards'

export default {
  id: 'greenhouse',
  name: 'Greenhouse',
  blurb: 'Greenhouse ATS (Airbnb, Spotify, Cloudflare, thousands more). Requires `org`.',
  needsOrg: true,

  async search({ org, keywords = '', location = '', limit = 25 } = {}) {
    if (!org) {
      throw new Error(
        '`org` is required: the slug in the company\'s Greenhouse board URL, e.g. "airbnb".'
      )
    }

    const data = await fetchJson(`${API}/${encodeURIComponent(org.trim())}/jobs`)

    const jobs = (data.jobs ?? []).map((job) => ({
      id: String(job.id),
      source: 'greenhouse',
      title: String(job.title ?? '').trim(),
      company: org.trim(),
      location: job.location?.name ?? '',
      url: job.absolute_url,
      postedAt: job.updated_at?.slice(0, 10) || undefined
    }))

    const filtered = filterJobs(jobs, { keywords, location })
    return { count: filtered.length, jobs: filtered.slice(0, limit) }
  },

  /** Greenhouse keeps the description on a separate, equally public endpoint. */
  async details({ org, id } = {}) {
    if (!org) throw new Error('`org` is required for Greenhouse details.')
    const data = await fetchJson(`${API}/${encodeURIComponent(org.trim())}/jobs/${id}`)

    return {
      id: String(data.id),
      source: 'greenhouse',
      title: String(data.title ?? '').trim(),
      company: org.trim(),
      location: data.location?.name ?? '',
      url: data.absolute_url,
      postedAt: data.updated_at?.slice(0, 10) || undefined,
      description: text(data.content)
    }
  }
}
