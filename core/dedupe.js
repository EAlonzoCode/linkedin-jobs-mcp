/**
 * Cross-source de-duplication for `search-all`.
 *
 * The same posting routinely appears on LinkedIn, Computrabajo and an ATS at
 * once. Merging them is what makes the aggregate view worth reading.
 *
 * Matching is deliberately conservative: identical normalised title + company.
 * A fuzzy match would be nicer to have, but merging two genuinely different
 * roles is worse than listing one twice, because the model then scores the
 * wrong job against a CV.
 */

/** Tokens that carry no identity. */
const STOP = new Set([
  'a', 'an', 'the', 'el', 'la', 'los', 'las', 'de', 'del', 'y', 'e', 'en', 'para', 'con',
  'junior', 'jr', 'senior', 'sr', 'mid', 'lead', 'staff', 'principal', 'ii', 'iii', '2',
  'remote', 'remoto', 'híbrido', 'hibrido', 'presencial', 'full', 'time', 'part', 'jornada',
  'completa', 'vacante', 'position', 'role', 'puesto'
])

/** Lowercases, strips accents/punctuation, drops stopwords. */
export function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
}

/** Stable de-dupe key for a job. */
export function jobKey(job) {
  return `${normalize(job.title).join(' ')}|${normalize(job.company).join(' ')}`
}

/** Jaccard similarity of two token arrays, 0..1. */
export function similarity(a, b) {
  const setA = new Set(a)
  const setB = new Set(b)
  if (!setA.size || !setB.size) return 0
  let shared = 0
  for (const token of setA) if (setB.has(token)) shared++
  return shared / (setA.size + setB.size - shared)
}

/**
 * Merges results from several sources, first occurrence wins.
 * `sources` is kept as an array so the caller can show every place a job lives.
 */
export function dedupe(jobs) {
  const byKey = new Map()
  for (const job of jobs) {
    const key = jobKey(job)
    const existing = byKey.get(key)
    if (existing) {
      if (!existing.sources.includes(job.source)) existing.sources.push(job.source)
      // Prefer whichever copy carries more detail.
      if (!existing.salary && job.salary) existing.salary = job.salary
      if (!existing.description && job.description) existing.description = job.description
      continue
    }
    byKey.set(key, { ...job, sources: [job.source] })
  }
  return [...byKey.values()]
}
