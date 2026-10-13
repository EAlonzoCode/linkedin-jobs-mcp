/**
 * Minimal HTML/text helpers.
 *
 * Deliberately no parser dependency. Every source here serves flat, stable
 * markup, and targeted regex is what keeps this project at zero dependencies.
 * If a source ever ships genuinely nested markup, add a real parser for that
 * source only — don't drag it into the shared budget.
 */

export function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

/** Strips tags, collapses whitespace, decodes entities. */
export function text(html) {
  if (!html) return ''
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|li|div|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** First capture group of `re`, or ''. */
export function match(html, re) {
  const m = html.match(re)
  return m ? m[1] : ''
}

/** All matches of `re` as an array. */
export function matchAll(html, re) {
  return [...html.matchAll(re)]
}

/**
 * Splits `html` into per-item chunks on `splitRe`, dropping the first piece
 * (which is the page header before the first item).
 */
export function chunks(html, splitRe) {
  return html.split(splitRe).slice(1)
}
