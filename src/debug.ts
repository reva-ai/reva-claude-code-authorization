// Opt-in via REVA_DEBUG=1. Writes to stderr only — stdout is reserved for
// the hook's JSON decision, so this never interferes with parsing.
export function debugLog(message: string): void {
  if (process.env.REVA_DEBUG) {
    process.stderr.write(`[reva-governance] ${message}\n`);
  }
}
