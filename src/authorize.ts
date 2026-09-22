import { getActiveSessionCount, markSessionActive } from './activeSessions';
import { buildActionContext, buildTransmission } from './context';
import { loadConfig } from './config';
import { debugLog } from './debug';
import { resolveMachineId } from './deviceId';
import { buildEntityDescriptor, directSpecOf, refOf } from './entity';
import { enqueuePendingSpawnLineage, loadAgentHops, resolveSubAgentLineage } from './hopChain';
import { resolveAgentContext, resolveUserEmail } from './identity';
import { mapToolToCedar } from './mapping';
import { triggerMcpIngestionForInvokedServer } from './mcpIngestionTrigger';
import { evaluate } from './rtgClient';
import { skipOutsideCodeScope } from './runtimeScope';
import { readStdin } from './stdin';
import { nextSpawnIndex } from './spawnCounter';
import { buildSessionContext, buildTraceId, traceparentHeader } from './trace';
import { CedarEntityDescriptor, CedarHop, CedarRequest, RtgResult, PreToolUseInput } from './types';
import { conversationFromTurn, directSessionFromTurn, loadOrStartTurn } from './turnCache';

function writeDecision(result: RtgResult): never {
  if (result.inactive) {
    // True pass-through: no Reva decision. In particular, do not emit
    // permissionDecision:"allow", which would bypass Claude's own prompt.
    process.exit(0);
  }
  const permissionDecision = result.decision === 'allow' ? 'allow' : result.decision === 'ask' ? 'ask' : 'deny';
  const output: Record<string, any> = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
    },
  };
  if (permissionDecision === 'deny') {
    output.hookSpecificOutput.permissionDecisionReason =
      result.reason || "Blocked by your organization's security policy.";
  } else if (permissionDecision === 'ask') {
    output.hookSpecificOutput.permissionDecisionReason = result.reason || 'Requires manual approval per Reva governance policy';
  }
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

async function main(): Promise<void> {
  if (skipOutsideCodeScope()) return;
  const raw = await readStdin();
  const input: PreToolUseInput = JSON.parse(raw);
  const cfg = loadConfig();
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  // Refreshes lastSeen for this session_id — keeps the active-sessions
  // registry accurate for as long as the session keeps being used, since
  // there's no confirmed hook for a session actually closing. Same for a
  // subagent's own tool calls: cfg.agentId is always this same run's
  // configured id regardless of subagent status, so this still refreshes
  // the right entry (the registry itself stays local-machine-scoped
  // regardless of what agentId now represents — see deviceId.ts).
  const currentSession = markSessionActive(
    cfg.agentId,
    input.session_id,
    process.env.CLAUDE_CODE_ENTRYPOINT || 'unknown',
    pluginDataDir,
  );
  const activeSessionCount = getActiveSessionCount(cfg.agentId, pluginDataDir);

  const agentCtx = resolveAgentContext(cfg.agentId, input);
  const mapping = mapToolToCedar(input.tool_name, input.tool_input || {}, input.cwd);

  // Ingest-on-invoke — an MCP server being used but not yet ingested gets a
  // discovery pass triggered now instead of at the next recheck. Wrapped in
  // its own try/catch on purpose: main()'s catch below fails CLOSED, so an
  // unexpected throw in this best-effort bookkeeping would DENY a legitimate
  // tool call. Nothing here is worth blocking a user's work over, so it is
  // contained and swallowed rather than allowed to reach that handler.
  try {
    const mcpServer = (mapping.resourceParents || []).find((parent) => parent.type === 'MCPServer');
    if (mcpServer) triggerMcpIngestionForInvokedServer(mcpServer.id, input.cwd, pluginDataDir);
  } catch (err: any) {
    debugLog(`authorize: ingest-on-invoke skipped — ${err?.message || String(err)}`);
  }

  // Read back the span/session metadata UserPromptSubmit recorded for this
  // turn. If no boundary exists, loadOrStartTurn records this first event as
  // the observed turn instead of inventing prior history.
  const turn = loadOrStartTurn(input.session_id, pluginDataDir);
  const spanId = turn.spanId || buildTraceId(input.session_id).slice(0, 16);
  const traceSession = buildSessionContext(input.session_id, spanId, input.prompt_id);
  const traceparent = traceparentHeader(traceSession.traceId, traceSession.spanId);

  // Cumulative spawn count for this session — only computed (and only
  // increments) for actual Task spawns, so unrelated tool calls don't
  // advance the counter.
  const subagentIndex =
    mapping.actionName === 'spawn' ? nextSpawnIndex(input.session_id, pluginDataDir) : undefined;

  // principal: the human who ultimately initiated this chain — resolved
  // the same way regardless of who's directly acting (Agent or SubAgent).
  const userEmail = resolveUserEmail();
  const userDescriptor = buildEntityDescriptor('User', userEmail);

  // subject: no parents on SubAgent — the schema declares SubAgent's
  // memberOfTypes as [], so it isn't valid for a SubAgent to claim
  // membership in Agent (or anything else).
  const subjectDescriptor: CedarEntityDescriptor = agentCtx.isSubAgent
    ? buildEntityDescriptor('SubAgent', `${agentCtx.agentId}:${agentCtx.subAgentId}`, {
        agentType: agentCtx.subAgentType || 'subagent',
      })
    : buildEntityDescriptor('Agent', agentCtx.agentId);
  const subject = refOf(subjectDescriptor);

  const resourceDescriptor = buildEntityDescriptor(
    mapping.resourceType,
    mapping.resourceId,
    mapping.resourceProperties,
    mapping.resourceParents,
  );
  const resource = refOf(resourceDescriptor);

  const hops: CedarHop[] = agentCtx.isSubAgent
    ? resolveSubAgentLineage(input.session_id, agentCtx.subAgentId!, pluginDataDir)
    : loadAgentHops(input.session_id, pluginDataDir);

  // The direct endpoint's current transmission describes this tool hop; if
  // the host calls this hook without UserPromptSubmit, use only real action
  // data observed here because the endpoint rejects a blank current prompt.
  const serializedInput = JSON.stringify(input.tool_input || {});
  const currentHopContent =
    mapping.command?.trim() || mapping.pattern?.trim() ||
    (serializedInput !== '{}' ? serializedInput : input.tool_name);

  const request: CedarRequest = {
    subject: directSpecOf(subjectDescriptor),
    principal: directSpecOf(userDescriptor),
    action: { name: mapping.actionName },
    resource: directSpecOf(resourceDescriptor),
    context: buildActionContext(mapping, {
      subagentIndex,
      hops,
      conversationMessages: conversationFromTurn(turn),
      activeSessionCount,
      currentSession,
      machineId: resolveMachineId(pluginDataDir),
    }),
    transmission: buildTransmission(currentHopContent, 'assistant', input.tool_name),
    session: directSessionFromTurn(input.session_id, turn),
  };

  // If this action IS a spawn, queue the lineage the resulting subagent
  // should inherit — its own id isn't known yet (Claude Code only reveals
  // it on that subagent's own first tool call), so this is matched up
  // later, in FIFO order, by resolveSubAgentLineage above.
  if (mapping.actionName === 'spawn') {
    const spawnHop: CedarHop = {
      seq: hops.length + 1,
      subject,
      action: { name: 'spawn' },
      resource,
      time: new Date().toISOString(),
    };
    enqueuePendingSpawnLineage(input.session_id, hops, spawnHop, pluginDataDir);
  }

  debugLog(
    `-> ${mapping.actionName} on ${mapping.resourceType}:${mapping.resourceId} (tool=${input.tool_name}${
      subagentIndex !== undefined ? `, subagentIndex=${subagentIndex}` : ''
    }, hops=${hops.length})`,
  );
  const result = await evaluate(cfg, request, traceparent, pluginDataDir);
  debugLog(`<- decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
  writeDecision(result);
}

main().catch((err: any) => {
  // Any unexpected failure (bad stdin JSON, mapping bug, etc.) must still
  // fail closed rather than let an uncaught exception exit non-zero, which
  // Claude Code treats as a non-blocking error and lets the tool call through.
  writeDecision({
    decision: 'deny',
    reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
  });
});
