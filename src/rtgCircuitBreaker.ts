import * as fs from 'node:fs';
import * as path from 'node:path';

// A local "stop calling the RTG, just allow" window opened after a 401 —
// checked at the very top of evaluate(), before any network call, so a
// principal that isn't provisioned yet (or a token that's gone bad) isn't
// re-checked on every single tool call and prompt until this expires. Keyed
// by Agent id, mirroring activeSessions.ts's local per-machine registry.
//
// 401 is the only status that opens this window (see rtgClient.ts's own
// comment on why) — every other operational failure (403/404/424/429/5xx,
// transport failures/timeouts) is a stateless per-call decision with no
// persisted state at all, so this module is never invoked for those.
// Expiring naturally re-probes the RTG on the next call, rather than
// needing a separate health check.
//
// Generic by design even though only one caller/duration exists today:
// nothing here hardcodes 401 or the 4-hour window — that classification
// lives entirely in rtgClient.ts, so this module doesn't need to change if
// that ever does.

interface CircuitBreakerState {
  disabledUntil: number;
  triggeredStatus: number;
  errorType?: string;
}

// No fallback: only ever writes inside CLAUDE_PLUGIN_DATA, same as every
// other local state file in this plugin.
function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'rtg-circuit-breaker') : undefined;
}

function cacheFile(agentId: string, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  if (!dir) return undefined;
  const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

export interface CircuitBreakerStatus {
  disabled: boolean;
  disabledUntil?: number;
  triggeredStatus?: number;
  errorType?: string;
}

// Read-only: an expired window is just reported as not-disabled, not
// deleted — the next tripCircuitBreaker() call overwrites the file
// regardless, so there's nothing to clean up here.
export function checkCircuitBreaker(agentId: string, pluginDataDir?: string): CircuitBreakerStatus {
  const file = cacheFile(agentId, pluginDataDir);
  if (!file) return { disabled: false };
  try {
    const state: CircuitBreakerState = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof state.disabledUntil === 'number' && Date.now() < state.disabledUntil) {
      return {
        disabled: true,
        disabledUntil: state.disabledUntil,
        triggeredStatus: state.triggeredStatus,
        errorType: state.errorType,
      };
    }
    return { disabled: false };
  } catch {
    return { disabled: false };
  }
}

// Opens (or extends/replaces) the breaker for durationMs from now, called
// right after a 401 response — the only status that currently triggers it
// (see rtgClient.ts).
export function tripCircuitBreaker(
  agentId: string,
  durationMs: number,
  triggeredStatus: number,
  errorType: string | undefined,
  pluginDataDir?: string,
): void {
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(agentId, pluginDataDir);
  if (!dir || !file) return;
  const state: CircuitBreakerState = { disabledUntil: Date.now() + durationMs, triggeredStatus, errorType };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch {
    // best effort — worst case the next few calls just hit the RTG for
    // real instead of short-circuiting
  }
}
