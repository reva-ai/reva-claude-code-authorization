import { markSessionInactive } from './activeSessions';
import { debugLog } from './debug';
import { resolveAgentId } from './deviceId';
import { skipOutsideCodeScope } from './runtimeScope';
import { readStdin } from './stdin';

// SessionEnd has no blocking/decision control (same as SessionStart) — it's
// pure local cleanup, immediately removing this session from the active-
// sessions registry (activeSessions.ts) rather than waiting out that file's
// 10-minute TTL. Every termination reason Claude Code reports (clear/
// resume/logout/prompt_input_exit/other) is treated the same: none of them
// mean this session is still concurrently running, which is all that
// registry tracks. Not guaranteed to fire on an abrupt termination (killed
// process, closed terminal) — the TTL stays as the fallback for exactly
// that gap; this is just the fast path for a graceful one. No RTG call, no
// full loadConfig(): nothing here is worth a network round-trip against
// Claude Code's tight, shared SessionEnd execution budget.
interface SessionEndInput {
  session_id: string;
  cwd: string;
  // Claude Code also sends a field naming why the session ended (clear/
  // resume/logout/prompt_input_exit/other) — not confirmed which literal
  // key carries it, and not needed here regardless, since every reason is
  // handled identically.
}

async function main(): Promise<void> {
  if (skipOutsideCodeScope()) return;
  const raw = await readStdin();
  const input: SessionEndInput = JSON.parse(raw);
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  // Resolved independently of loadConfig() — same reasoning as
  // sessionStart.ts's own active-session tracking: this is local
  // bookkeeping only, so it shouldn't need the auth token (or anything
  // else loadConfig() requires) to succeed first.
  const agentId = process.env.REVA_AGENT_ID || resolveAgentId();
  if (!agentId) {
    debugLog('sessionEnd: skipped — no Anthropic account logged in and REVA_AGENT_ID not set');
  } else {
    try {
      markSessionInactive(agentId, input.session_id, pluginDataDir);
    } catch (err: any) {
      debugLog(`sessionEnd: markSessionInactive failed — ${err?.message || String(err)}`);
    }
  }

  process.exit(0); // clean no-op pass-through — no stdout, nothing to block on
}

main().catch(() => process.exit(0));
