import { getActiveSessionCount, getSessionEntry } from './activeSessions';
import { buildActionContext, buildToolResponseTransmission } from './context';
import { loadConfig } from './config';
import { debugLog } from './debug';
import { resolveMachineId } from './deviceId';
import { buildEntityDescriptor, directSpecOf } from './entity';
import { loadAgentHops, resolveSubAgentLineage } from './hopChain';
import { resolveAgentContext, resolveUserEmail } from './identity';
import { mapToolToCedar } from './mapping';
import { evaluate } from './rtgClient';
import { skipOutsideCodeScope } from './runtimeScope';
import { readStdin } from './stdin';
import { buildSessionContext, deriveSpanId, traceparentHeader } from './trace';
import { CedarEntityDescriptor, CedarRequest, RtgResult, PostToolUseInput } from './types';
import { conversationFromTurn, directSessionFromTurn, loadOrStartTurn, resolveTurnTraceId } from './turnCache';

// PostToolUse fires after the tool has already run. An RTG deny cannot undo
// it; it surfaces as a top-level decision:"block" so Claude sees the reason
// next to the tool result. Same fail-closed posture as PreToolUse: unexpected
// errors still block further work rather than exiting non-zero (which Claude
// Code treats as a non-blocking hook error).
function writeDecision(result: RtgResult): never {
  if (result.inactive) {
    // The inactive circuit is a no-op, including after a tool result.
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
          hookEventName: 'PostToolUse',
          additionalContext: `Reva governance: tool result requires elevated review (${
            result.reason || 'conditional policy match'
          })`,
        },
      }),
    );
  }
  process.exit(0);
}

async function main(): Promise<void> {
  if (skipOutsideCodeScope()) return;
  const raw = await readStdin();
  const input: PostToolUseInput = JSON.parse(raw);
  const cfg = loadConfig();
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  // Read-only here, not a refresh — PreToolUse already marked this same
  // tool call's session active moments earlier in the same cycle.
  const activeSessionCount = getActiveSessionCount(cfg.agentId, pluginDataDir);
  const currentSession = getSessionEntry(cfg.agentId, input.session_id, pluginDataDir);

  const agentCtx = resolveAgentContext(cfg.agentId, input);
  const mapping = mapToolToCedar(input.tool_name, input.tool_input || {}, input.cwd);

  const turn = loadOrStartTurn(input.session_id, pluginDataDir);
  // trace = this turn (shared by every call the prompt fans out into),
  // span = this tool call. The span key is tool_name + tool_input, which
  // PostToolUse sees identically, so the pre/post pair shares one span
  // without either process having to tell the other anything.
  const traceId = resolveTurnTraceId(input.session_id, turn);
  const spanId = deriveSpanId(traceId, `tool:${input.tool_name}:${JSON.stringify(input.tool_input || {})}`);
  const traceSession = buildSessionContext(input.session_id, spanId, traceId, input.prompt_id);
  const traceparent = traceparentHeader(traceSession.traceId, traceSession.spanId);

  const userEmail = resolveUserEmail();
  const userDescriptor = buildEntityDescriptor('User', userEmail);

  const subjectDescriptor: CedarEntityDescriptor = agentCtx.isSubAgent
    ? buildEntityDescriptor('SubAgent', `${agentCtx.agentId}:${agentCtx.subAgentId}`, {
        agentType: agentCtx.subAgentType || 'subagent',
      })
    : buildEntityDescriptor('Agent', agentCtx.agentId);

  const resourceDescriptor = buildEntityDescriptor(
    mapping.resourceType,
    mapping.resourceId,
    mapping.resourceProperties,
    mapping.resourceParents,
  );

  const hops = agentCtx.isSubAgent
    ? resolveSubAgentLineage(input.session_id, agentCtx.subAgentId!, pluginDataDir)
    : loadAgentHops(input.session_id, pluginDataDir);

  const serializedInput = JSON.stringify(input.tool_input || {});
  const currentHopFallback =
    mapping.command?.trim() || mapping.pattern?.trim() ||
    (serializedInput !== '{}' ? serializedInput : input.tool_name);

  const request: CedarRequest = {
    subject: directSpecOf(subjectDescriptor),
    principal: directSpecOf(userDescriptor),
    action: { name: mapping.actionName },
    resource: directSpecOf(resourceDescriptor),
    context: buildActionContext(mapping, {
      hops,
      conversationMessages: conversationFromTurn(turn),
      activeSessionCount,
      currentSession,
      machineId: resolveMachineId(pluginDataDir),
    }),
    // The tool result lives here — not in closed Cedar context — so the
    // evaluate payload carries the actual response without a schema change.
    transmission: buildToolResponseTransmission(input.tool_response, currentHopFallback),
    session: directSessionFromTurn(input.session_id, turn),
  };

  debugLog(
    `-> post ${mapping.actionName} on ${mapping.resourceType}:${mapping.resourceId} (tool=${input.tool_name}, hops=${hops.length})`,
  );
  const result = await evaluate(cfg, request, traceparent, pluginDataDir, input.session_id);
  debugLog(`<- post decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
  writeDecision(result);
}

main().catch((err: any) => {
  // The ONLY record this denial leaves. writeDecision exits the process
  // immediately after printing the hook response, so without this line a
  // fail-closed deny is invisible everywhere except the UI toast the user
  // sees — which is exactly why an intermittent config failure looked
  // random and undiagnosable.
  debugLog(`PostToolUse: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
  writeDecision({
    decision: 'deny',
    reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
  });
});
