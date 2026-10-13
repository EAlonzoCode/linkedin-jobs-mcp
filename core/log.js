/** Diagnostics go to stderr; stdout is reserved for the MCP transport. */
export function log(...args) {
  process.stderr.write(`[${new Date().toISOString()}] ${args.join(' ')}\n`)
}
