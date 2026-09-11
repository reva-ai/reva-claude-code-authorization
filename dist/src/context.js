"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildActionContext = buildActionContext;
exports.buildInvokeAgentContext = buildInvokeAgentContext;
exports.buildTransmission = buildTransmission;
exports.serializeToolResponse = serializeToolResponse;
exports.buildToolResponseTransmission = buildToolResponseTransmission;
const ingestionClient_1 = require("./ingestionClient");
function activeTurnEvidence(extras) {
    const messages = extras.conversationMessages || [];
    return {
        // Canonical direct-AI placement. An empty array is meaningful for the
        // first hop of a turn and keeps every request on one stable shape.
        hops: extras.hops || [],
        ...(messages.length > 0 ? { conversation: { messages } } : {}),
    };
}
function activeSessionFields(extras) {
    return {
        activeSessionCount: extras.activeSessionCount ?? 0,
        sessionId: extras.currentSession?.sessionId ?? '',
        sessionEntryPoint: extras.currentSession?.entrypoint ?? '',
        sessionLastSeen: extras.currentSession?.lastSeen ?? 0,
        agentType: ingestionClient_1.AGENT_TYPE,
    };
}
function buildActionContext(mapping, extras = {}) {
    const timestamp = Date.now();
    const evidence = activeTurnEvidence(extras);
    const sessions = activeSessionFields(extras);
    switch (mapping.actionName) {
        case 'invokeTool':
            return { timestamp, ...evidence, ...sessions };
        case 'spawn':
            return { timestamp, subagentIndex: extras.subagentIndex ?? 1, ...evidence, ...sessions };
        case 'executeBash':
            return { timestamp, command: mapping.command ?? '', ...evidence, ...sessions };
        case 'read':
        case 'write':
        case 'edit':
        case 'glob':
        case 'grep':
            return { timestamp, ...evidence, ...sessions };
        default:
            return { timestamp, ...evidence, ...sessions };
    }
}
function buildInvokeAgentContext(activeSessionCount = 0, currentSession) {
    return { timestamp: Date.now(), hops: [], ...activeSessionFields({ activeSessionCount, currentSession }) };
}
// `role`/`contentType`/`promptKey` are constants here — Claude Code doesn't
// expose a multi-role or multi-content-type concept at the hook level, only
// ever the current turn's plain-text prompt.
function buildTransmission(content, role, nonblankFallback) {
    const userQuery = content.trim() ? content : (nonblankFallback || '').trim();
    if (!userQuery) {
        throw new Error('direct AI evaluation requires a nonblank current prompt');
    }
    return { promptKey: 'userQuery', userQuery, role, contentType: 'text/plain' };
}
const MAX_TOOL_RESPONSE_LENGTH = 2000;
function serializeToolResponse(toolResponse) {
    if (toolResponse == null)
        return '';
    const raw = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
    return raw.length > MAX_TOOL_RESPONSE_LENGTH ? `${raw.slice(0, MAX_TOOL_RESPONSE_LENGTH)}…` : raw;
}
// PostToolUse: the tool has already returned, so transmission carries that
// result (role "tool") instead of the user prompt. context no longer
// carries a `prompt` field at all — that's now PDP-managed, not client-set.
function buildToolResponseTransmission(toolResponse, nonblankFallback) {
    const content = serializeToolResponse(toolResponse);
    const transmission = buildTransmission(content, 'tool', nonblankFallback);
    transmission.contentType =
        content && typeof toolResponse !== 'string' && toolResponse != null ? 'application/json' : 'text/plain';
    return transmission;
}
