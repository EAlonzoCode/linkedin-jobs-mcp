/**
 * Computrabajo Chile — the biggest pure job board in Chile after LinkedIn.
 *
 * No API and no login: `cl.computrabajo.com` serves fully server-rendered
 * HTML, which is what makes it practical to read at all. Two very different
 * pages are involved:
 *
 *  - Search: `/empleos-de-{keyword}` returns `<article class="box_offer">`
 *    cards. Unknown slugs don't 404 — they quietly serve the homepage, so a
 *    soft-404 check is required.
 *  - Detail: carries a schema.org `JobPosting` in a `@graph` JSON-LD block.
 *    That is the parsing path used here: structured data beats brittle regex
 *    whenever it is available.
 */
import { fetchUrl } from '../core/http.js'
import { match, text } from '../core/html.js'

const BASE = 'https://cl.computrabajo.com'
const ABSOLUTE = /^\s*https?:\/\//i

/**
 * Detail pages are addressed as `/ofertas-de-trabajo/oferta-de-trabajo-de-{slug}-{ID}`.
 * The slug is cosmetic — verified that `...de-x-{ID}` still resolves to the right
 * posting — so the numeric id alone is enough to rebuild a working URL.
 */
function detailUrl(id) {
  return `${BASE}/ofertas-de-trabajo/oferta-de-trabajo-de-x-${id}`
}

/** "Data Engineer" -> "data-engineer"; also strips the Spanish accents. */
export function slugify(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function absolute(url) {
  if (!url) return ''
  const clean = String(url).trim().split('#')[0]
  return ABSOLUTE.test(clean) ? clean : BASE + clean
}

export default {
  id: 'computrabajo',
  name: 'Computrabajo',
  blurb: 'Chile + ~20 LatAm countries. Server-rendered HTML, no login.',

  async search({ keywords, location = '', start = 0, limit = 25 } = {}) {
    const term = String(keywords ?? '').trim()
    if (!term) throw new Error('`keywords` is required.')

    const slug = slugify(term)
    const locSlug = slugify(location)
    let url = `${BASE}/empleos-de-${slug}`
    if (locSlug) url += `-en-${locSlug}`

    let html = await fetchUrl(url)

    // Soft-404: an unknown location slug silently returns the homepage.
    let cards = splitCards(html)
    if (!cards.length && locSlug) {
      html = await fetchUrl(`${BASE}/empleos-de-${slug}`)
      cards = splitCards(html)
    }

    const jobs = cards.map(parseCard).filter((job) => job.id)
    const trimmed = location ? jobs.filter((job) => jobMatchesLocation(job, location)) : jobs
    const offset = Number(start) || 0

    return {
      count: Number(match(html, /Consulta las ([\d.,]+) ofertas/) || trimmed.length),
      url,
      jobs: trimmed.slice(offset, offset + Math.min(Number(limit) || 25, 50))
    }
  },

  /** Reads the schema.org JSON-LD block, which carries the full description. */
  async details({ id } = {}) {
    if (!id) throw new Error('`id` is required.')
    const html = await fetchUrl(detailUrl(id))
    const posting = extractJobPosting(html)
    if (!posting) {
      throw new Error(`Job ${id} was not found, or the listing is no longer published.`)
    }

    const address = posting.jobLocation?.address ?? {}
    return {
      id: String(id),
      source: 'computrabajo',
      title: text(posting.title),
      company: text(posting.hiringOrganization?.name),
      location: [address.addressRegion, address.addressLocality].filter(Boolean).join(', '),
      country: address.addressCountry,
      url: posting.url || detailUrl(id),
      postedAt: posting.datePosted || undefined,
      validThrough: posting.validThrough || undefined,
      employmentType: posting.employmentType || undefined,
      salary: formatSalary(posting.baseSalary, posting.salaryCurrency),
      description: text(posting.description)
    }
  }
}

/** Splits the results page into one chunk per job card. */
function splitCards(html) {
  return html.split(/(?=<article class="box_offer)/).slice(1)
}

function parseCard(card) {
  const id = match(card, /data-id='([0-9A-F]+)'/) || match(card, /data-id="([0-9A-F]+)"/)
  if (!id) return {}

  const url = absolute(
    match(card, /<a class="js-o-link fc_base" href="([^"]+)"/) ||
      match(card, /<a[^>]*class="[^"]*js-o-link[^"]*"[^>]*href="([^"]+)"/)
  )

  // Two layouts: a linked company name, or — on promoted "destacado" cards —
  // anonymous plain text such as "Importante empresa del sector".
  const company =
    text(match(card, /offer-grid-article-company-url[^>]*>([\s\S]*?)<\/a>/)) ||
    text(match(card, /<p class="dFlex vm_fx fs16 fc_base mt5">([\s\S]*?)<\/p>/))

  const location = text(
    match(card, /<p class="fs16 fc_base mt5">\s*<span class="mr10">([\s\S]*?)<\/span>/)
  )
  const postedAt = text(match(card, /<p class="fs13 fc_aux mt15">([\s\S]*?)<\/p>/))

  const job = {
    id,
    source: 'computrabajo',
    title: text(match(card, /<h2[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/)),
    company,
    location,
    url: url || detailUrl(id)
  }
  if (postedAt) job.postedAt = postedAt
  if (/i_home_office/.test(card)) job.workMode = 'Híbrido/remoto'

  return job
}

/** Finds the JobPosting node inside a `@graph`-shaped JSON-LD payload. */
function extractJobPosting(html) {
  for (const raw of [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]) {
    let data
    try {
      data = JSON.parse(raw[1])
    } catch {
      continue // malformed JSON-LD is common enough to be worth skipping
    }
    if (data?.['@type'] === 'JobPosting') return data
    if (Array.isArray(data?.['@graph'])) {
      const found = data['@graph'].find((node) => node?.['@type'] === 'JobPosting')
      if (found) return found
    }
  }
  return null
}

function jobMatchesLocation(job, wanted) {
  const needle = String(wanted).toLowerCase().trim()
  return (
    String(job.location ?? '').toLowerCase().includes(needle) ||
    String(job.title ?? '').toLowerCase().includes(needle)
  )
}

function formatSalary(baseSalary, currency) {
  const value = baseSalary?.value
  if (!value) return undefined
  const min = value.minValue ?? value.value
  const max = value.maxValue ?? value.value
  if (min == null && max == null) return undefined
  const unit = value.unitText ? ` ${value.unitText}` : ''
  return `${currency ?? ''} ${min ?? '?'} – ${max ?? '?'}${unit}`.replace(/\s+/g, ' ').trim()
}
