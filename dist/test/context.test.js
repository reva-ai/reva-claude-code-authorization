"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const context_1 = require("../src/context");
const hops = [
    {
        seq: 1,
        subject: { type: 'User', id: 'alice' },
        action: { name: 'invokeAgent' },
        resource: { type: 'Agent', id: 'agent-a' },
        time: '2026-08-19T10:00:00Z',
    },
];
const conversationMessages = [
    {
        seq: 1,
        role: 'user',
        contentType: 'text/plain',
        content: 'do the thing',
        timestamp: '2026-08-19T10:00:00Z',
    },
];
const CONTEXT_KEYS = ['activeSessionCount', 'sessionId', 'sessionEntryPoint', 'sessionLastSeen', 'agentType', 'hops', 'timestamp'].sort();
(0, node_test_1.test)('invokeAgent context is timestamp + hops + session scalars + agentType — no prompt (PDP-managed, not client-set)', () => {
    const ctx = (0, context_1.buildInvokeAgentContext)();
    strict_1.default.deepEqual(Object.keys(ctx).sort(), CONTEXT_KEYS);
    strict_1.default.equal('prompt' in ctx, false);
    strict_1.default.deepEqual(ctx.hops, []);
    strict_1.default.equal(ctx.activeSessionCount, 0);
    strict_1.default.equal(ctx.sessionId, '');
    strict_1.default.equal(ctx.sessionEntryPoint, '');
    strict_1.default.equal(ctx.sessionLastSeen, 0);
    strict_1.default.equal(ctx.agentType, 'ClaudeCode');
});
(0, node_test_1.test)('invokeAgent context carries the current session as flat scalars, plus the aggregate count', () => {
    const currentSession = { sessionId: 's1', entrypoint: 'cli', lastSeen: 1000 };
    const ctx = (0, context_1.buildInvokeAgentContext)(2, currentSession);
    strict_1.default.equal(ctx.activeSessionCount, 2);
    strict_1.default.equal(ctx.sessionId, 's1');
    strict_1.default.equal(ctx.sessionEntryPoint, 'cli');
    strict_1.default.equal(ctx.sessionLastSeen, 1000);
});
(0, node_test_1.test)('invokeTool context is timestamp only, no prompt or session', () => {
    const mapping = { actionName: 'invokeTool', resourceType: 'Tool', resourceId: 'WebFetch' };
    const ctx = (0, context_1.buildActionContext)(mapping);
    strict_1.default.deepEqual(Object.keys(ctx).sort(), CONTEXT_KEYS);
    strict_1.default.equal('prompt' in ctx, false);
    strict_1.default.equal('session' in ctx, false);
});
(0, node_test_1.test)('spawn context is scalar policy attributes plus canonical hops, with no nested session record', () => {
    const mapping = { actionName: 'spawn', resourceType: 'SubAgent', resourceId: 'Explore' };
    const ctx = (0, context_1.buildActionContext)(mapping, { hops });
    strict_1.default.deepEqual(Object.keys(ctx).sort(), [...CONTEXT_KEYS, 'subagentIndex'].sort());
    strict_1.default.deepEqual(ctx.hops, hops);
    strict_1.default.equal('session' in ctx, false);
});
(0, node_test_1.test)('executeBash context has scalar action attributes and no managed context record', () => {
    const mapping = {
        actionName: 'executeBash',
        resourceType: 'File',
        resourceId: '/repo/a.ts',
        command: 'cat /repo/a.ts',
    };
    const ctx = (0, context_1.buildActionContext)(mapping);
    strict_1.default.deepEqual(Object.keys(ctx).sort(), [...CONTEXT_KEYS, 'command'].sort());
    strict_1.default.equal(ctx.command, 'cat /repo/a.ts');
    strict_1.default.equal('session' in ctx, false);
});
(0, node_test_1.test)('read/write/edit context is timestamp only — no prompt, session, tool, or command', () => {
    for (const actionName of ['read', 'write', 'edit']) {
        const mapping = {
            actionName,
            resourceType: 'File',
            resourceId: '/repo/a.ts',
            tool: 'Edit',
        };
        const ctx = (0, context_1.buildActionContext)(mapping);
        strict_1.default.deepEqual(Object.keys(ctx).sort(), CONTEXT_KEYS);
        strict_1.default.equal('prompt' in ctx, false);
    }
});
(0, node_test_1.test)('glob/grep context is timestamp only — no prompt, session, tool, or pattern', () => {
    for (const actionName of ['glob', 'grep']) {
        const mapping = {
            actionName,
            resourceType: 'Directory',
            resourceId: '/repo/src',
            tool: actionName === 'glob' ? 'Glob' : 'Grep',
            pattern: 'TODO',
        };
        const ctx = (0, context_1.buildActionContext)(mapping);
        strict_1.default.deepEqual(Object.keys(ctx).sort(), CONTEXT_KEYS);
        strict_1.default.equal('prompt' in ctx, false);
    }
});
(0, node_test_1.test)('buildActionContext carries the current session as flat scalars, plus the aggregate count, on every action', () => {
    const currentSession = { sessionId: 's3', entrypoint: 'sdk-cli', lastSeen: 3000 };
    const mapping = { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' };
    const ctx = (0, context_1.buildActionContext)(mapping, { activeSessionCount: 3, currentSession });
    strict_1.default.equal(ctx.activeSessionCount, 3);
    strict_1.default.equal(ctx.sessionId, 's3');
    strict_1.default.equal(ctx.sessionEntryPoint, 'sdk-cli');
    strict_1.default.equal(ctx.sessionLastSeen, 3000);
});
(0, node_test_1.test)('session fields default to empty/0 when not provided', () => {
    const mapping = { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' };
    const ctx = (0, context_1.buildActionContext)(mapping);
    strict_1.default.equal(ctx.activeSessionCount, 0);
    strict_1.default.equal(ctx.sessionId, '');
    strict_1.default.equal(ctx.sessionEntryPoint, '');
    strict_1.default.equal(ctx.sessionLastSeen, 0);
});
(0, node_test_1.test)('agentType is the constant "ClaudeCode" on every action, not runtime-detected', () => {
    const actions = [
        { actionName: 'invokeTool', resourceType: 'Tool', resourceId: 'WebFetch' },
        { actionName: 'spawn', resourceType: 'SubAgent', resourceId: 'Explore' },
        { actionName: 'executeBash', resourceType: 'Directory', resourceId: '/repo', command: 'ls' },
        { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' },
        { actionName: 'glob', resourceType: 'Directory', resourceId: '/repo' },
    ];
    for (const mapping of actions) {
        strict_1.default.equal((0, context_1.buildActionContext)(mapping).agentType, 'ClaudeCode');
    }
    strict_1.default.equal((0, context_1.buildInvokeAgentContext)().agentType, 'ClaudeCode');
});
(0, node_test_1.test)('timestamp is a Long (epoch milliseconds), not an ISO string, on every action', () => {
    const now = Date.now();
    const actions = [
        { actionName: 'invokeTool', resourceType: 'Tool', resourceId: 'WebFetch' },
        { actionName: 'spawn', resourceType: 'SubAgent', resourceId: 'Explore' },
        { actionName: 'executeBash', resourceType: 'Directory', resourceId: '/repo', command: 'ls' },
        { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts' },
        { actionName: 'glob', resourceType: 'Directory', resourceId: '/repo' },
    ];
    for (const mapping of actions) {
        const ts = (0, context_1.buildActionContext)(mapping).timestamp;
        strict_1.default.equal(typeof ts, 'number');
        strict_1.default.ok(ts >= now, `timestamp for ${mapping.actionName} should be a recent epoch-ms value`);
    }
    strict_1.default.equal(typeof (0, context_1.buildInvokeAgentContext)().timestamp, 'number');
});
(0, node_test_1.test)('prompt is never present in context, on any action — it is PDP-managed, not client-set', () => {
    const invokeTool = { actionName: 'invokeTool', resourceType: 'Tool', resourceId: 'WebFetch' };
    strict_1.default.equal('prompt' in (0, context_1.buildActionContext)(invokeTool), false);
    const bash = { actionName: 'executeBash', resourceType: 'Directory', resourceId: '/repo', command: 'ls' };
    strict_1.default.equal('prompt' in (0, context_1.buildActionContext)(bash), false);
    const read = { actionName: 'read', resourceType: 'File', resourceId: '/repo/a.ts', tool: 'Read' };
    strict_1.default.equal('prompt' in (0, context_1.buildActionContext)(read), false);
    const spawn = { actionName: 'spawn', resourceType: 'SubAgent', resourceId: 'Explore' };
    strict_1.default.equal('prompt' in (0, context_1.buildActionContext)(spawn), false);
    strict_1.default.equal('prompt' in (0, context_1.buildInvokeAgentContext)(), false);
});
(0, node_test_1.test)('spawn context uses the real subagentIndex when provided, defaults to 1 otherwise', () => {
    const mapping = { actionName: 'spawn', resourceType: 'SubAgent', resourceId: 'Explore' };
    strict_1.default.equal((0, context_1.buildActionContext)(mapping).subagentIndex, 1);
    strict_1.default.equal((0, context_1.buildActionContext)(mapping, { subagentIndex: 4 }).subagentIndex, 4);
});
(0, node_test_1.test)('active-turn evidence uses context.conversation and context.hops with object actions', () => {
    const mapping = { actionName: 'read', resourceType: 'File', resourceId: 'repo/a.ts' };
    const ctx = (0, context_1.buildActionContext)(mapping, { hops, conversationMessages });
    strict_1.default.deepEqual(ctx.hops, hops);
    strict_1.default.deepEqual(ctx.conversation, { messages: conversationMessages });
    strict_1.default.deepEqual(ctx.hops[0].action, { name: 'invokeAgent' });
});
(0, node_test_1.test)('transmission uses canonical dynamic userQuery selector and semantic role', () => {
    strict_1.default.deepEqual((0, context_1.buildTransmission)('run tests', 'assistant'), {
        promptKey: 'userQuery',
        userQuery: 'run tests',
        role: 'assistant',
        contentType: 'text/plain',
    });
});
(0, node_test_1.test)('buildToolResponseTransmission puts a JSON tool_response in userQuery with role tool', () => {
    const tx = (0, context_1.buildToolResponseTransmission)({ filePath: '/repo/a.ts', success: true }, 'Edit');
    strict_1.default.equal(tx.role, 'tool');
    strict_1.default.equal(tx.promptKey, 'userQuery');
    strict_1.default.equal(tx.contentType, 'application/json');
    strict_1.default.equal(tx.userQuery, JSON.stringify({ filePath: '/repo/a.ts', success: true }));
});
(0, node_test_1.test)('buildToolResponseTransmission keeps a string tool_response as text/plain', () => {
    const tx = (0, context_1.buildToolResponseTransmission)('     1\thello\n', 'Read');
    strict_1.default.equal(tx.role, 'tool');
    strict_1.default.equal(tx.contentType, 'text/plain');
    strict_1.default.equal(tx.userQuery, '     1\thello\n');
});
(0, node_test_1.test)('serializeToolResponse treats null/undefined as empty string', () => {
    strict_1.default.equal((0, context_1.serializeToolResponse)(undefined), '');
    strict_1.default.equal((0, context_1.serializeToolResponse)(null), '');
    strict_1.default.equal((0, context_1.buildToolResponseTransmission)(undefined, 'Read').userQuery, 'Read');
});
(0, node_test_1.test)('serializeToolResponse truncates very long responses', () => {
    const long = 'x'.repeat(3000);
    const serialized = (0, context_1.serializeToolResponse)(long);
    strict_1.default.ok(serialized.length < long.length);
    strict_1.default.ok(serialized.endsWith('…'));
});
