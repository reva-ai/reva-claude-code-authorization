import * as fs from 'node:fs';
import * as path from 'node:path';

// Tracks how many subagents have been spawned so far *this turn*, so a
// Cedar policy can see "this is spawn #4" and enforce a per-turn cap (e.g.
// deny when subagentIndex > 5). Resets to 0 at the start of every new turn
// (see resetSpawnCounter, called from authorizePrompt.ts's startTurn) —
// deliberately NOT a running total for the whole session, since a cap meant
// to bound one turn's fan-out would otherwise keep tightening across a long
// session until every later turn's first spawn was already over the limit.
// Persisted per session_id since each hook invocation is a separate,
// stateless process — a simple read-increment-write on a small file, not
// safe against truly concurrent writers, but Claude Code invokes a
// session's own PreToolUse hooks sequentially, so this is safe in practice.

// No fallback: only ever writes inside CLAUDE_PLUGIN_DATA (Claude Code's
// own per-plugin data directory — the officially documented mechanism for
// exactly this). Without it, there is nothing honest to write to —
// nextSpawnIndex still returns a value (every call is index 1, since
// nothing persists), it just can't actually count across calls.
function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'spawns') : undefined;
}

function cacheFile(sessionId: string, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  if (!dir) return undefined;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safe}.count`);
}

export function nextSpawnIndex(sessionId: string, pluginDataDir?: string): number {
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(sessionId, pluginDataDir);
  if (!dir || !file) return 1;

  let current = 0;
  try {
    current = Number(fs.readFileSync(file, 'utf8').trim()) || 0;
  } catch {
    current = 0;
  }
  const next = current + 1;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, String(next), 'utf8');
  } catch {
    // best effort — if persistence fails, this call still gets a value,
    // just not guaranteed to increment correctly on the next spawn
  }
  return next;
}

// Called once per turn, from UserPromptSubmit (authorizePrompt.ts), right
// alongside startTurn() — so this turn's first spawn is #1 again, not a
// continuation of every prior turn's count.
export function resetSpawnCounter(sessionId: string, pluginDataDir?: string): void {
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    // already absent (first turn ever, or already reset) — nothing to do
  }
}
