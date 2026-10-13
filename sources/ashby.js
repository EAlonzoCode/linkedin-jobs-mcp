/**
 * Ashby — an ATS popular with venture-backed startups.
 *
 * `api.ashbyhq.com/posting-api/job-board/{org}` is Ashby's published public
 * board API, no auth. It is the ATS behind Ramp, Notion, Vanta and Linear,
 * among others.
 *
 * Like Lever it returns the full description inline, and unlike the others it
 * can include compensation, which makes it the best source here for salary
 * signals.
 */
import { fetchJson } from '../core/http.js'
import { filterJobs } from '../core/filter.js'

const API = 'https://api.ashbyhq.com/posting-api/job-board'

export default {
  id: 'ashby',
  name: 'Ashby',
  blurb: 'Ashby ATS (Ramp, Notion, Vanta, Linear). Requires `org`. Includes compensation.',
  needsOrg: true,

  async search({ org, keywords = '', location = '', limit = 25 } = {}) {
    if (!org) {
      throw new Error('`org` is required: the company slug on its Ashby board, e.g. "notion".')
    }

    const data = await fetchJson(`${API}/${encodeURIComponent(org.trim())}?includeCompensation=true`)

    const jobs = (data.jobs ?? [])
      .filter((j) => j.isListed !== false)
      .map((j) => ({
        id: String(j.id),
        source: 'ashby',
        title: String(j.title ?? '').trim(),
        company: org.trim(),
        location: j.location ?? (j.isRemote ? 'Remote' : ''),
        url: j.jobUrl,
        employmentType: j.employmentType || undefined,
        department: j.department || undefined,
        team: j.team || undefined,
        isRemote: j.isRemote || undefined,
        compensation: formatCompensation(j.compensation),
        postedAt: j.publishedAt?.slice(0, 10) || undefined,
        description: j.descriptionPlain || undefined
      }))

    const filtered = filterJobs(jobs, { keywords, location })
    return { count: filtered.length, jobs: filtered.slice(0, limit) }
  },

  async details({ org, id } = {}) {
    if (!org) throw new Error('`org` is required for Ashby details.')
    const data = await fetchJson(`${API}/${encodeURIComponent(org.trim())}?includeCompensation=true`)
    const found = (data.jobs ?? []).find((j) => String(j.id) === String(id))
    if (!found) throw new Error(`Job ${id} not found on the "${org}" Ashby board.`)

    return {
      id: String(found.id),
      source: 'ashby',
      title: String(found.title ?? '').trim(),
      company: org.trim(),
      location: found.location ?? (found.isRemote ? 'Remote' : ''),
      url: found.jobUrl,
      compensation: formatCompensation(found.compensation),
      postedAt: found.publishedAt?.slice(0, 10) || undefined,
      description: found.descriptionPlain || ''
    }
  }
}

/** Ashby's compensation shape varies; flatten it to one readable string. */
function formatCompensation(compensation) {
  if (!compensation) return undefined
  const range = compensation.min ?? compensation.minSalary
  const max = compensation.max ?? compensation.maxSalary
  if (range == null && max == null) return undefined
  const currency = compensation.currency ?? ''
  const interval = compensation.interval ? ` ${compensation.interval}` : ''
  return `${currency} ${range ?? '?'} – ${max ?? '?'}${interval}`.trim()
}
