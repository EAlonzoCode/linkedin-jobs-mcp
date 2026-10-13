/**
 * Remotive — curated remote jobs, with a published public JSON API.
 *
 * Unlike the scraped sources, `remotive.com/api` supports a `search`
 * parameter, so keyword filtering happens server-side and the request stays
 * small.
 */
import { fetchUrl } from '../core/http.js'
import { text } from '../core/html.js'
import { matchesLocation } from '../core/filter.js'

const API = 'https://remotive.com/api/remote-jobs'

export default {
  id: 'remotive',
  name: 'Remotive',
  blurb: 'Curated remote jobs. Public JSON API with server-side search.',

  async search({ keywords = '', location = '', start = 0, limit = 25 } = {}) {
    const term = String(keywords).trim()
    if (!term) throw new Error('`keywords` is required.')

    // limit=50 over-fetches so the location filter still has room to cut.
    const params = new URLSearchParams({ search: term, limit: '50' })

    const data = await fetchUrl(`${API}?${params}`, { as: 'json' })
    const jobs = (data.jobs ?? []).map((job) => ({
      id: String(job.id),
      source: 'remotive',
      title: String(job.title ?? '').trim(),
      company: job.company_name ?? '',
      location: job.candidate_required_location || 'Anywhere',
      url: job.url,
      category: job.category || undefined,
      jobType: job.job_type || undefined,
      salary: job.salary || undefined,
      tags: job.tags?.length ? job.tags : undefined,
      postedAt: job.publication_date?.slice(0, 10) || undefined,
      description: text(job.description) || undefined
    }))

    const filtered = jobs.filter((job) => matchesLocation(job.location, location))
    return {
      count: filtered.length,
      jobs: filtered.slice(Number(start) || 0, (Number(start) || 0) + Math.min(Number(limit) || 25, 50))
    }
  }
}
