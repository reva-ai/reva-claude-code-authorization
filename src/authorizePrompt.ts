import { getActiveSessionCount, markSessionActive } from './activeSessions';
import { loadConfig } from './config';
import { debugLog } from './debug';
import { resolveMachineId } from './deviceId';
import { startTurnHops } from './hopChain';
import { resolveUserEmail } from './identity';
import { buildInvokeAgentRequest } from './invokeAgent';
import { triggerMcpDiscoveryIfDue } from './mcpIngestionTrigger';
import { evaluate } from './rtgClient';
import { skipOutsideCodeScope } from './runtimeScope';
import { resetSpawnCounter } from './spawnCounter';
import { readStdin } from './stdin';
import { buildSessionContext, traceparentHeader } from './trace';
import { CedarHop, RtgResult, UserPromptSubmitInput } from './types';
import { directSessionFromTurn, startTurn, truncatePrompt } from './turnCache';

// UserPromptSubmit uses a different, binary output schema than PreToolUse
// (top-level decision:"block" vs hookSpecificOutput.permissionDecision).
// The direct-AI client is status-authoritative: 200 passes and blocking
// policy/input statuses return deny.
function writeDecision(result: RtgResult): never {
  if (result.inactive) {
    // No output means the Reva hook is inactive and Claude continues with its
    // native behavior; an explicit allow/block would still enforce a choice.
  } else if (result.decision === 'deny') {
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: result.reason || "Blocked by your organization's security policy.",
      }),
    );
  } else if (result.decision === 'ask') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `Reva governance: this session requires elevated review (${
            result.reason || 'conditional policy match'
          }); individual tool calls will still be evaluated.`,
        },
      }),
    );
  }
  process.exit(0);
}

async function main(): Promise<void> {
  if (skipOutsideCodeScope()) return;
  const raw = await readStdin();
  const input: UserPromptSubmitInput = JSON.parse(raw);
  const cfg = loadConfig();
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  // Closes the gap between SessionStart's once-per-session discovery pass
  // and a connector added mid-session: UserPromptSubmit fires every turn,
  // so re-checking here (throttled to ~15 minutes, see
  // mcpIngestionTrigger.ts) picks up a new connector well before the next
  // SessionStart would. A no-op, non-blocking cache read when not yet due.
  triggerMcpDiscoveryIfDue(input.cwd, pluginDataDir);

  const userEmail = resolveUserEmail();
  const prompt = input.prompt ? truncatePrompt(input.prompt) : '';

  // UserPromptSubmit fires every turn, unlike SessionStart (once per
  // session) — a good second place to keep this session's lastSeen fresh.
  const currentSession = markSessionActive(
    cfg.agentId,
    input.session_id,
    process.env.CLAUDE_CODE_ENTRYPOINT || 'unknown',
    pluginDataDir,
  );
  const activeSessionCount = getActiveSessionCount(cfg.agentId, pluginDataDir);

  // This plugin owns the turn boundary itself: mint a fresh span id here
  // and persist it (with the prompt text) so every PreToolUse call this
  // turn produces — separate, stateless hook processes — reads the same
  // value back instead of each rolling its own.
  const turn = startTurn(input.session_id, input.prompt, pluginDataDir);
  // Same turn boundary resets the subagent spawn counter — each turn's
  // first spawn is #1 again, not a continuation of every prior turn's
  // count (see spawnCounter.ts's own comment on why).
  resetSpawnCounter(input.session_id, pluginDataDir);
  const traceSession = buildSessionContext(input.session_id, turn.spanId, input.prompt_id);
  const traceparent = traceparentHeader(traceSession.traceId, traceSession.spanId);

  const request = buildInvokeAgentRequest(
    userEmail,
    cfg.agentId,
    prompt,
    directSessionFromTurn(input.session_id, turn),
    activeSessionCount,
    currentSession,
    resolveMachineId(pluginDataDir),
  );

  debugLog(`-> invokeAgent as ${userEmail} on Agent:${cfg.agentId}`);
  const result = await evaluate(cfg, request, traceparent, pluginDataDir);
  debugLog(`<- decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);

  // Record this invokeAgent as the base of this turn's hop chain regardless
  // of the decision, so a subsequent tool call (if the turn proceeds) has
  // it to build on — mirrors how the spawn counter also advances on every
  // attempt, not just approved ones.
  const invokeAgentHop: CedarHop = {
    seq: 1,
    subject: request.subject,
    action: { name: 'invokeAgent' },
    resource: request.resource,
    time: new Date().toISOString(),
  };
  startTurnHops(input.session_id, invokeAgentHop, pluginDataDir);

  writeDecision(result);
}

main().catch((err: any) => {
  writeDecision({
    decision: 'deny',
    reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
  });
});
