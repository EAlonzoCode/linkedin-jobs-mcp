/**
 * Source registry.
 *
 * Adding a job board = dropping one file in `sources/` that default-exports a
 * source object. Nothing else in the project needs to change: the transport
 * builds a tool per source, and `search-all` picks it up automatically.
 *
 * Source contract:
 *   id          short slug, becomes part of the tool name
 *   name        human label
 *   blurb       one line the model reads when picking a source
 *   searchable  false to hide it from search tools (details-only sources)
 *   needsOrg    true for ATS sources addressed per company
 *   search(args) -> { count?, jobs: Job[] }
 *   details(id)  -> Job            optional
 *
 * Job shape: { id, title, company, location, url, source, ...optional }
 */
import linkedin from '../sources/linkedin.js'
import greenhouse from '../sources/greenhouse.js'
import lever from '../sources/lever.js'
import ashby from '../sources/ashby.js'
import computrabajo from '../sources/computrabajo.js'
import remoteok from '../sources/remoteok.js'
import remotive from '../sources/remotive.js'

export const SOURCES = [
  linkedin,
  greenhouse,
  lever,
  ashby,
  computrabajo,
  remoteok,
  remotive
]

export const BY_ID = new Map(SOURCES.map((s) => [s.id, s]))

export function getSource(id) {
  const source = BY_ID.get(String(id ?? '').toLowerCase())
  if (!source) {
    throw new Error(`Unknown source "${id}". Available: ${SOURCES.map((s) => s.id).join(', ')}`)
  }
  return source
}

export function searchableSources() {
  return SOURCES.filter((s) => s.searchable !== false)
}
