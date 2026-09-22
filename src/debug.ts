import * as fs from 'node:fs';
import * as path from 'node:path';

// Opt-in via REVA_DEBUG=1. Always writes to stderr (unmodified — a live
// terminal watching a hook run directly still sees exactly this). Also
// appends a timestamped copy to CLAUDE_PLUGIN_DATA/debug.log when that's
// set: stderr alone isn't enough for a hook invoked by the Desktop app
// (Chat/Cowork) rather than a terminal, since there's no confirmed way to
// know whether — or where — that stderr gets captured. The file is the
// one destination guaranteed to be checkable afterward, regardless of what
// actually ran the hook. Timestamped here specifically because this file
// accumulates across every hook invocation, across every session, not just
// one live-watched run — stderr's own line stays untimestamped since nothing
// else about its format has changed.
export function debugLog(message: string): void {
  if (!process.env.REVA_DEBUG) return;
  process.stderr.write(`[reva-security] ${message}\n`);

  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (!pluginDataDir) return;
  try {
    fs.mkdirSync(pluginDataDir, { recursive: true });
    fs.appendFileSync(path.join(pluginDataDir, 'debug.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // best effort — this plugin's own logging must never itself crash a hook
  }
}
