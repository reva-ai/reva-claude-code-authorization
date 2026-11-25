import { getActiveSessionCount, markSessionActive } from './activeSessions';
import { loadConfig } from './config';
import { debugLog } from './debug';
import { resolveMachineId } from './deviceId';
import { resolveUserEmail } from './identity';
import { buildInvokeAgentRequest } from './invokeAgent';
import { triggerMcpDiscoveryIfDue } from './mcpIngestionTrigger';
import { readPluginVersionGate } from './pluginVersionGate';
import { evaluate } from './rtgClient';
import { skipOutsideCodeScope } from './runtimeScope';
import { resolveSessionModel } from './sessionModel';
import { resetSpawnCounter } from './spawnCounter';
import { readStdin } from './stdin';
import { buildSessionContext, deriveSpanId, traceparentHeader } from './trace';
import { RtgResult, UserPromptSubmitInput } from './types';
import {
  cleanSubmittedPrompt,
  directSessionFromTurn,
  resolveTurnTraceId,
  startTurn,
  truncatePrompt,
} from './turnCache';

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

  // SessionStart latches an outdated plugin. Block the turn here (decision:
  // block) before evaluate so the model never runs on a version-blocked
  // session.
  const versionGate = readPluginVersionGate(input.session_id, pluginDataDir);
  if (versionGate.status === 'blocked') {
    debugLog(`UserPromptSubmit: plugin version blocked — ${versionGate.reason}`);
    writeDecision({
      decision: 'deny',
      reason: versionGate.reason,
      errorType: versionGate.errorType,
      status: 403,
    });
  }

  // Closes the gap between SessionStart's once-per-session discovery pass
  // and a connector added mid-session: UserPromptSubmit fires every turn,
  // so re-checking here (throttled to ~15 minutes, see
  // mcpIngestionTrigger.ts) picks up a new connector well before the next
  // SessionStart would. A no-op, non-blocking cache read when not yet due.
  triggerMcpDiscoveryIfDue(input.cwd, pluginDataDir);

  const userEmail = resolveUserEmail();
  // The cleaned prompt goes to Reva as the invokeAgent userQuery and nowhere
  // else: it is not kept on this machine.
  const submittedPrompt = input.prompt ? cleanSubmittedPrompt(input.prompt) : '';
  const prompt = submittedPrompt ? truncatePrompt(submittedPrompt) : '';

  // UserPromptSubmit fires every turn, unlike SessionStart (once per
  // session) — a good second place to keep this session's lastSeen fresh.
  const currentSession = markSessionActive(
    cfg.agentId,
    input.session_id,
    process.env.CLAUDE_CODE_ENTRYPOINT || 'unknown',
    pluginDataDir,
  );
  const activeSessionCount = getActiveSessionCount(cfg.agentId, pluginDataDir);

  // This plugin owns the turn boundary itself: mint a fresh trace id here
  // and persist it (id and turn number only, no prompt text) so every
  // PreToolUse call this turn produces — separate, stateless hook
  // processes — reads the same value back instead of each rolling its own.
  const turn = startTurn(input.session_id, pluginDataDir);
  // Same turn boundary resets the subagent spawn counter — each turn's
  // first spawn is #1 again, not a continuation of every prior turn's
  // count (see spawnCounter.ts's own comment on why).
  resetSpawnCounter(input.session_id, pluginDataDir);
  // This hook opens the turn, so its trace id is the one every tool call in
  // the turn will read back. Its own span is the prompt evaluation itself.
  const traceId = resolveTurnTraceId(input.session_id, turn);
  const spanId = deriveSpanId(traceId, 'user-prompt');
  const traceSession = buildSessionContext(input.session_id, spanId, traceId, input.prompt_id);
  const traceparent = traceparentHeader(traceSession.traceId, traceSession.spanId);

  // The model this session is running on — see sessionModel.ts. Best-effort:
  // resolveSessionModel never throws, and an unknown model is just omitted.
  const sessionModel = cfg.modelContext
    ? resolveSessionModel(input.session_id, input.transcript_path, pluginDataDir)
    : undefined;

  const request = buildInvokeAgentRequest(
    userEmail,
    cfg.agentId,
    prompt,
    directSessionFromTurn(input.session_id),
    activeSessionCount,
    currentSession,
    resolveMachineId(pluginDataDir),
    sessionModel?.model,
  );

  debugLog(
    `-> invokeAgent as ${userEmail} on Agent:${cfg.agentId} (model=${
      sessionModel ? `${sessionModel.model ?? 'unknown'} via ${sessionModel.source}` : 'off'
    })`,
  );
  const result = await evaluate(cfg, request, traceparent, pluginDataDir, input.session_id);
  debugLog(`<- decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);

  // Hops are recorded by RTG from evaluate — do not persist a local hop chain
  // under CLAUDE_PLUGIN_DATA (that used to write hops/*.json on the machine).

  writeDecision(result);
}

main().catch((err: any) => {
  // The ONLY record this denial leaves. writeDecision exits the process
  // immediately after printing the hook response, so without this line a
  // fail-closed deny is invisible everywhere except the UI toast the user
  // sees — which is exactly why an intermittent config failure looked
  // random and undiagnosable.
  debugLog(`UserPromptSubmit: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
  writeDecision({
    decision: 'deny',
    reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
  });
});
