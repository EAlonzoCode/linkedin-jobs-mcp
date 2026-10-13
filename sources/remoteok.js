/**
 * RemoteOK — remote jobs worldwide, notable for shipping salary figures.
 *
 * `remoteok.com/api` is a public JSON feed. The first array element is not a
 * job but a legal notice about scraping terms, so it has to be skipped.
 *
 * Their terms ask that clients send a User-Agent carrying contact info. Set
 * `REMOTEOK_CONTACT` (e.g. your email) to send it; nothing personal is baked
 * into this repository.
 */
import { fetchUrl } from '../core/http.js'
import { text } from '../core/html.js'
import { filterJobs } from '../core/filter.js'

const API = 'https://remoteok.com/api'

export default {
  id: 'remoteok',
  name: 'RemoteOK',
  blurb: 'Remote jobs worldwide, with salary ranges. Free JSON feed.',

  async search({ keywords = '', location = '', start = 0, limit = 25 } = {}) {
    if (!String(keywords).trim()) throw new Error('`keywords` is required.')

    const contact = process.env.REMOTEOK_CONTACT
    const headers = contact ? { 'User-Agent': `linkedin-jobs-mcp (${contact})` } : {}

    const payload = await fetchUrl(API, { headers, as: 'json' })
    if (!Array.isArray(payload)) throw new Error('RemoteOK returned an unexpected payload.')

    // Element 0 is RemoteOK's own legal notice, not a posting.
    const jobs = payload
      .filter((item) => item?.position && item?.id)
      .map((item) => {
        const job = {
          id: String(item.id),
          source: 'remoteok',
          title: String(item.position).trim(),
          company: item.company ?? '',
          location: item.location || 'Anywhere',
          url: item.url || item.apply_url,
          postedAt: item.date?.slice(0, 10) || undefined,
          tags: item.tags?.length ? item.tags : undefined,
          // Kept only so keyword matching can see it; `project()` drops it from summaries.
          description: text(item.description) || undefined
        }
        if (item.salary_min || item.salary_max) {
          job.salary = `USD ${item.salary_min ?? '?'} – ${item.salary_max ?? '?'} / year`
        }
        return job
      })

    const filtered = filterJobs(jobs, { keywords, location })
    return {
      count: filtered.length,
      jobs: filtered.slice(Number(start) || 0, (Number(start) || 0) + Math.min(Number(limit) || 25, 50))
    }
  }
}
