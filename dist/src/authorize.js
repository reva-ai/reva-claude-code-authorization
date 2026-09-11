"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const context_1 = require("./context");
const config_1 = require("./config");
const debug_1 = require("./debug");
const entity_1 = require("./entity");
const hopChain_1 = require("./hopChain");
const identity_1 = require("./identity");
const mapping_1 = require("./mapping");
const pdpClient_1 = require("./pdpClient");
const stdin_1 = require("./stdin");
const spawnCounter_1 = require("./spawnCounter");
const trace_1 = require("./trace");
const turnCache_1 = require("./turnCache");
function writeDecision(result) {
    if (result.inactive) {
        // True pass-through: no Reva decision. In particular, do not emit
        // permissionDecision:"allow", which would bypass Claude's own prompt.
        process.exit(0);
    }
    const permissionDecision = result.decision === 'allow' ? 'allow' : result.decision === 'ask' ? 'ask' : 'deny';
    const output = {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision,
        },
    };
    if (permissionDecision === 'deny') {
        output.hookSpecificOutput.permissionDecisionReason = result.reason || 'Blocked by Reva governance policy';
    }
    else if (permissionDecision === 'ask') {
        output.hookSpecificOutput.permissionDecisionReason = result.reason || 'Requires manual approval per Reva governance policy';
    }
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
}
async function main() {
    const raw = await (0, stdin_1.readStdin)();
    const input = JSON.parse(raw);
    const cfg = (0, config_1.loadConfig)();
    const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
    // Refreshes lastSeen for this session_id — keeps the active-sessions
    // registry accurate for as long as the session keeps being used, since
    // there's no confirmed hook for a session actually closing. Same for a
    // subagent's own tool calls: cfg.agentId is always this same run's
    // configured id regardless of subagent status, so this still refreshes
    // the right entry (the registry itself stays local-machine-scoped
    // regardless of what agentId now represents — see deviceId.ts).
    const currentSession = (0, activeSessions_1.markSessionActive)(cfg.agentId, input.session_id, process.env.CLAUDE_CODE_ENTRYPOINT || 'unknown', pluginDataDir);
    const activeSessionCount = (0, activeSessions_1.getActiveSessionCount)(cfg.agentId, pluginDataDir);
    const agentCtx = (0, identity_1.resolveAgentContext)(cfg.agentId, input);
    const mapping = (0, mapping_1.mapToolToCedar)(input.tool_name, input.tool_input || {}, input.cwd);
    // Read back the span/session metadata UserPromptSubmit recorded for this
    // turn. If no boundary exists, loadOrStartTurn records this first event as
    // the observed turn instead of inventing prior history.
    const turn = (0, turnCache_1.loadOrStartTurn)(input.session_id, pluginDataDir);
    const spanId = turn.spanId || (0, trace_1.buildTraceId)(input.session_id).slice(0, 16);
    const traceSession = (0, trace_1.buildSessionContext)(input.session_id, spanId, input.prompt_id);
    const traceparent = (0, trace_1.traceparentHeader)(traceSession.traceId, traceSession.spanId);
    // Cumulative spawn count for this session — only computed (and only
    // increments) for actual Task spawns, so unrelated tool calls don't
    // advance the counter.
    const subagentIndex = mapping.actionName === 'spawn' ? (0, spawnCounter_1.nextSpawnIndex)(input.session_id, pluginDataDir) : undefined;
    // principal: the human who ultimately initiated this chain — resolved
    // the same way regardless of who's directly acting (Agent or SubAgent).
    const userEmail = (0, identity_1.resolveUserEmail)();
    const userDescriptor = (0, entity_1.buildEntityDescriptor)('User', userEmail);
    // subject: no parents on SubAgent — the schema declares SubAgent's
    // memberOfTypes as [], so it isn't valid for a SubAgent to claim
    // membership in Agent (or anything else).
    const subjectDescriptor = agentCtx.isSubAgent
        ? (0, entity_1.buildEntityDescriptor)('SubAgent', `${agentCtx.agentId}:${agentCtx.subAgentId}`, {
            agentType: agentCtx.subAgentType || 'subagent',
        })
        : (0, entity_1.buildEntityDescriptor)('Agent', agentCtx.agentId);
    const subject = (0, entity_1.refOf)(subjectDescriptor);
    const resourceDescriptor = (0, entity_1.buildEntityDescriptor)(mapping.resourceType, mapping.resourceId, mapping.resourceProperties, mapping.resourceParents);
    const resource = (0, entity_1.refOf)(resourceDescriptor);
    const hops = agentCtx.isSubAgent
        ? (0, hopChain_1.resolveSubAgentLineage)(input.session_id, agentCtx.subAgentId, pluginDataDir)
        : (0, hopChain_1.loadAgentHops)(input.session_id, pluginDataDir);
    // The direct endpoint's current transmission describes this tool hop; if
    // the host calls this hook without UserPromptSubmit, use only real action
    // data observed here because the endpoint rejects a blank current prompt.
    const serializedInput = JSON.stringify(input.tool_input || {});
    const currentHopContent = mapping.command?.trim() || mapping.pattern?.trim() ||
        (serializedInput !== '{}' ? serializedInput : input.tool_name);
    const request = {
        subject: (0, entity_1.directSpecOf)(subjectDescriptor),
        principal: (0, entity_1.directSpecOf)(userDescriptor),
        action: { name: mapping.actionName },
        resource: (0, entity_1.directSpecOf)(resourceDescriptor),
        context: (0, context_1.buildActionContext)(mapping, {
            subagentIndex,
            hops,
            conversationMessages: (0, turnCache_1.conversationFromTurn)(turn),
            activeSessionCount,
            currentSession,
        }),
        transmission: (0, context_1.buildTransmission)(currentHopContent, 'assistant', input.tool_name),
        session: (0, turnCache_1.directSessionFromTurn)(input.session_id, turn),
    };
    // If this action IS a spawn, queue the lineage the resulting subagent
    // should inherit — its own id isn't known yet (Claude Code only reveals
    // it on that subagent's own first tool call), so this is matched up
    // later, in FIFO order, by resolveSubAgentLineage above.
    if (mapping.actionName === 'spawn') {
        const spawnHop = {
            seq: hops.length + 1,
            subject,
            action: { name: 'spawn' },
            resource,
            time: new Date().toISOString(),
        };
        (0, hopChain_1.enqueuePendingSpawnLineage)(input.session_id, hops, spawnHop, pluginDataDir);
    }
    (0, debug_1.debugLog)(`-> ${mapping.actionName} on ${mapping.resourceType}:${mapping.resourceId} (tool=${input.tool_name}${subagentIndex !== undefined ? `, subagentIndex=${subagentIndex}` : ''}, hops=${hops.length})`);
    const result = await (0, pdpClient_1.evaluate)(cfg, request, traceparent);
    (0, debug_1.debugLog)(`<- decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
    writeDecision(result);
}
main().catch((err) => {
    // Any unexpected failure (bad stdin JSON, mapping bug, etc.) must still
    // fail closed rather than let an uncaught exception exit non-zero, which
    // Claude Code treats as a non-blocking error and lets the tool call through.
    writeDecision({
        decision: 'deny',
        reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
    });
});
