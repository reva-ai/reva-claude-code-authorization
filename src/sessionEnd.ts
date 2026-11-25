import { markSessionInactive } from './activeSessions';
import { debugLog } from './debug';
import { resolveAgentId } from './deviceId';
import { skipOutsideCodeScope } from './runtimeScope';
import { clearSessionModel } from './sessionModel';
import { readStdin } from './stdin';

// SessionEnd has no blocking/decision control (same as SessionStart) — local
// cleanup only. Trace summarize belongs on Stop (end of a turn), not here.
// Not guaranteed to fire on an abrupt termination.
interface SessionEndInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
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
    debugLog('sessionEnd: skipped active-session cleanup — no Anthropic account logged in and REVA_AGENT_ID not set');
  } else {
    try {
      markSessionInactive(agentId, input.session_id, pluginDataDir);
    } catch (err: any) {
      debugLog(`sessionEnd: markSessionInactive failed — ${err?.message || String(err)}`);
    }
  }

  // Independent of agentId — the recorded model is keyed by session only.
  clearSessionModel(input.session_id, pluginDataDir);

  process.exit(0); // clean no-op pass-through — no stdout, nothing to block on
}

main().catch(() => process.exit(0));
