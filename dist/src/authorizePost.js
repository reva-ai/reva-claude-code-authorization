"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const context_1 = require("./context");
const config_1 = require("./config");
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const entity_1 = require("./entity");
const hopChain_1 = require("./hopChain");
const identity_1 = require("./identity");
const mapping_1 = require("./mapping");
const rtgClient_1 = require("./rtgClient");
const runtimeScope_1 = require("./runtimeScope");
const stdin_1 = require("./stdin");
const trace_1 = require("./trace");
const turnCache_1 = require("./turnCache");
// PostToolUse fires after the tool has already run. An RTG deny cannot undo
// it; it surfaces as a top-level decision:"block" so Claude sees the reason
// next to the tool result. Same fail-closed posture as PreToolUse: unexpected
// errors still block further work rather than exiting non-zero (which Claude
// Code treats as a non-blocking hook error).
function writeDecision(result) {
    if (result.inactive) {
        // The inactive circuit is a no-op, including after a tool result.
    }
    else if (result.decision === 'deny') {
        process.stdout.write(JSON.stringify({
            decision: 'block',
            reason: result.reason || "Blocked by your organization's security policy.",
        }));
    }
    else if (result.decision === 'ask') {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'PostToolUse',
                additionalContext: `Reva governance: tool result requires elevated review (${result.reason || 'conditional policy match'})`,
            },
        }));
    }
    process.exit(0);
}
async function main() {
    if ((0, runtimeScope_1.skipOutsideCodeScope)())
        return;
    const raw = await (0, stdin_1.readStdin)();
    const input = JSON.parse(raw);
    const cfg = (0, config_1.loadConfig)();
    const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
    // Read-only here, not a refresh — PreToolUse already marked this same
    // tool call's session active moments earlier in the same cycle.
    const activeSessionCount = (0, activeSessions_1.getActiveSessionCount)(cfg.agentId, pluginDataDir);
    const currentSession = (0, activeSessions_1.getSessionEntry)(cfg.agentId, input.session_id, pluginDataDir);
    const agentCtx = (0, identity_1.resolveAgentContext)(cfg.agentId, input);
    const mapping = (0, mapping_1.mapToolToCedar)(input.tool_name, input.tool_input || {}, input.cwd);
    const turn = (0, turnCache_1.loadOrStartTurn)(input.session_id, pluginDataDir);
    const spanId = turn.spanId || (0, trace_1.buildTraceId)(input.session_id).slice(0, 16);
    const traceSession = (0, trace_1.buildSessionContext)(input.session_id, spanId, input.prompt_id);
    const traceparent = (0, trace_1.traceparentHeader)(traceSession.traceId, traceSession.spanId);
    const userEmail = (0, identity_1.resolveUserEmail)();
    const userDescriptor = (0, entity_1.buildEntityDescriptor)('User', userEmail);
    const subjectDescriptor = agentCtx.isSubAgent
        ? (0, entity_1.buildEntityDescriptor)('SubAgent', `${agentCtx.agentId}:${agentCtx.subAgentId}`, {
            agentType: agentCtx.subAgentType || 'subagent',
        })
        : (0, entity_1.buildEntityDescriptor)('Agent', agentCtx.agentId);
    const resourceDescriptor = (0, entity_1.buildEntityDescriptor)(mapping.resourceType, mapping.resourceId, mapping.resourceProperties, mapping.resourceParents);
    const hops = agentCtx.isSubAgent
        ? (0, hopChain_1.resolveSubAgentLineage)(input.session_id, agentCtx.subAgentId, pluginDataDir)
        : (0, hopChain_1.loadAgentHops)(input.session_id, pluginDataDir);
    const serializedInput = JSON.stringify(input.tool_input || {});
    const currentHopFallback = mapping.command?.trim() || mapping.pattern?.trim() ||
        (serializedInput !== '{}' ? serializedInput : input.tool_name);
    const request = {
        subject: (0, entity_1.directSpecOf)(subjectDescriptor),
        principal: (0, entity_1.directSpecOf)(userDescriptor),
        action: { name: mapping.actionName },
        resource: (0, entity_1.directSpecOf)(resourceDescriptor),
        context: (0, context_1.buildActionContext)(mapping, {
            hops,
            conversationMessages: (0, turnCache_1.conversationFromTurn)(turn),
            activeSessionCount,
            currentSession,
            machineId: (0, deviceId_1.resolveMachineId)(pluginDataDir),
        }),
        // The tool result lives here — not in closed Cedar context — so the
        // evaluate payload carries the actual response without a schema change.
        transmission: (0, context_1.buildToolResponseTransmission)(input.tool_response, currentHopFallback),
        session: (0, turnCache_1.directSessionFromTurn)(input.session_id, turn),
    };
    (0, debug_1.debugLog)(`-> post ${mapping.actionName} on ${mapping.resourceType}:${mapping.resourceId} (tool=${input.tool_name}, hops=${hops.length})`);
    const result = await (0, rtgClient_1.evaluate)(cfg, request, traceparent, pluginDataDir);
    (0, debug_1.debugLog)(`<- post decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
    writeDecision(result);
}
main().catch((err) => {
    writeDecision({
        decision: 'deny',
        reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
    });
});
