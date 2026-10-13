/**
 * Client-side filtering.
 *
 * The ATS APIs are "give me everything this company has open" — they have no
 * search parameter. So keyword and location matching happen here, on the
 * client, instead of over the wire.
 */

export function tokenize(query) {
  return String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Every token must appear somewhere in `haystack` (AND semantics).
 * An empty query matches everything.
 */
export function matchesKeywords(haystack, keywords) {
  const tokens = tokenize(keywords)
  if (!tokens.length) return true
  const hay = String(haystack ?? '').toLowerCase()
  return tokens.every((token) => hay.includes(token))
}

/** Case-insensitive substring match; empty wanted matches everything. */
export function matchesLocation(jobLocation, wanted) {
  const needle = String(wanted ?? '').trim().toLowerCase()
  if (!needle) return true
  return String(jobLocation ?? '').toLowerCase().includes(needle)
}

/** Applies both filters to a list of jobs. */
export function filterJobs(jobs, { keywords = '', location = '' } = {}) {
  return jobs.filter((job) => {
    const haystack = [job.title, job.company, job.description].filter(Boolean).join(' ')
    return matchesKeywords(haystack, keywords) && matchesLocation(job.location, location)
  })
}
