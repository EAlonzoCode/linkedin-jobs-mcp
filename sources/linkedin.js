/**
 * LinkedIn — via the *guest* endpoints, i.e. the same HTML the logged-out Jobs
 * page returns. No OAuth, no cookies, no session, so your account is never
 * involved and there is no account risk.
 *
 * That also bounds the scope: no `send-message`, no `connect`, no feed. Those
 * genuinely require an authenticated session and this source deliberately has
 * none.
 *
 * Both endpoints are undocumented and LinkedIn retires them without notice —
 * `/jobs-guest/jobs/api/view/{id}` already 404s, which is why details come
 * from the public job page instead.
 */
import { fetchUrl } from '../core/http.js'
import { decodeEntities, match, text } from '../core/html.js'

const BASE = 'https://www.linkedin.com'

export default {
  id: 'linkedin',
  name: 'LinkedIn',
  blurb: "LinkedIn's logged-out guest pages. No account involved.",

  async search({ keywords, location = '', start = 0, limit = 25 } = {}) {
    const term = String(keywords ?? '').trim()
    if (!term) throw new Error('`keywords` is required.')

    const params = new URLSearchParams({
      keywords: term,
      location: String(location ?? '').trim(),
      trk: 'public_jobs_jobs-search-bar_search-submit',
      position: '1',
      pageNum: '0',
      start: String(Number(start) || 0)
    })

    const html = await fetchUrl(`${BASE}/jobs-guest/jobs/api/seeMoreJobPostings/search?${params}`)

    // Each card owns exactly one entity-URN, so splitting on it yields one chunk per job.
    const cards = html.split(/(?=data-entity-urn="urn:li:jobPosting:)/).slice(1)
    const jobs = cards.map(parseCard).filter((job) => job.id)

    return {
      count: jobs.length,
      jobs: jobs.slice(0, Math.min(Number(limit) || 25, 50))
    }
  },

  async details({ id } = {}) {
    const jobId = extractJobId(id)
    if (!jobId) throw new Error(`Could not extract a job id from "${id}"`)

    const html = await fetchUrl(`${BASE}/jobs/view/${jobId}`)
    const job = {
      id: jobId,
      source: 'linkedin',
      title: text(match(html, /<h1[^>]*class="[^"]*top-card-layout__title[^"]*"[^>]*>([\s\S]*?)<\/h1>/)),
      company: text(match(html, /<a[^>]*class="[^"]*topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\/a>/)),
      location: text(match(html, /<span class="topcard__flavor topcard__flavor--bullet">([\s\S]*?)<\/span>/)),
      description: text(
        match(html, /<div class="show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/)
      ),
      criteria: [],
      url: `${BASE}/jobs/view/${jobId}`
    }

    // Criteria come as two parallel class lists (subheaders and values), so zip them.
    const labels = [
      ...html.matchAll(/<h3 class="description__job-criteria-subheader[^"]*"[^>]*>([\s\S]*?)<\/h3>/g)
    ].map((m) => text(m[1]))
    const values = [
      ...html.matchAll(/<span class="description__job-criteria-text[^"]*"[^>]*>([\s\S]*?)<\/span>/g)
    ].map((m) => text(m[1]))
    for (let i = 0; i < Math.max(labels.length, values.length); i++) {
      if (labels[i] || values[i]) {
        job.criteria.push({ label: labels[i] ?? '', value: values[i] ?? '' })
      }
    }

    const applicants = text(
      match(html, /<span class="[^"]*num-applicants__caption[^"]*"[^>]*>([\s\S]*?)<\/span>/)
    )
    if (applicants) job.applicants = applicants

    const postedRelative = text(
      match(html, /<span class="[^"]*posted-time-ago__text[^"]*"[^>]*>([\s\S]*?)<\/span>/)
    )
    if (postedRelative) job.postedRelative = postedRelative

    const postedAt = match(html, /<time[^>]*datetime="([^"]+)"/)
    if (postedAt) job.postedAt = postedAt

    if (/Solicitud sencilla|Easy Apply/i.test(html)) job.easyApply = true

    if (!job.title && !job.description) {
      throw new Error(`Job ${jobId} is no longer posted, or it is private.`)
    }
    return job
  }
}

function parseCard(card) {
  const id = match(card, /data-entity-urn="urn:li:jobPosting:(\d+)"/)
  const url = match(card, /class="base-card__full-link[^"]*"\s+href="([^"]+)"/)

  const job = {
    id,
    source: 'linkedin',
    title: text(match(card, /<h3 class="base-search-card__title">([\s\S]*?)<\/h3>/)),
    company: text(match(card, /<h4 class="base-search-card__subtitle">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/)),
    location: text(match(card, /<span class="job-search-card__location">([\s\S]*?)<\/span>/)),
    url: decodeEntities(url) || (id ? `${BASE}/jobs/view/${id}` : '')
  }

  const postedAt = match(card, /<time[^>]*datetime="([^"]+)"/)
  if (postedAt) job.postedAt = postedAt

  const note = text(match(card, /<span class="job-posting-benefits__text">([\s\S]*?)<\/span>/))
  if (note) job.note = note

  return job
}

/** Normalises a LinkedIn permalink down to a bare numeric job id. */
export function extractJobId(input) {
  const value = String(input ?? '').trim()
  if (/^\d{6,}$/.test(value)) return value
  const urn = value.match(/jobPosting:(\d+)/)
  if (urn) return urn[1]
  const view = value.match(/\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,})(?:[/?#]|$)/)
  if (view) return view[1]
  const digits = value.match(/(\d{9,})/)
  return digits ? digits[1] : ''
}
