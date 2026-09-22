"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const invokeAgent_1 = require("../src/invokeAgent");
const session = {
    id: '33333333-3333-4333-8333-333333333333',
    turn: 3,
    startedAt: '2026-08-14T09:57:30Z',
};
(0, node_test_1.test)('buildInvokeAgentRequest emits the canonical direct-AI User to Agent envelope', () => {
    const request = (0, invokeAgent_1.buildInvokeAgentRequest)('alice@example.com', 'agent-a', 'hello', session);
    strict_1.default.deepEqual(request.subject, { type: 'User', id: 'alice@example.com' });
    strict_1.default.deepEqual(request.principal, request.subject);
    strict_1.default.deepEqual(request.action, { name: 'invokeAgent' });
    strict_1.default.deepEqual(request.resource, { type: 'Agent', id: 'agent-a' });
    strict_1.default.deepEqual(request.transmission, {
        promptKey: 'userQuery',
        userQuery: 'hello',
        role: 'user',
        contentType: 'text/plain',
    });
    strict_1.default.deepEqual(request.context.hops, []);
    strict_1.default.deepEqual(request.session, session);
    strict_1.default.equal('messages' in request.session, false);
    strict_1.default.equal('entities' in request, false);
    strict_1.default.equal('hops' in request, false);
});
(0, node_test_1.test)('buildInvokeAgentRequest never fabricates a current prompt', () => {
    strict_1.default.throws(() => (0, invokeAgent_1.buildInvokeAgentRequest)('alice@example.com', 'agent-a', '', session), /nonblank current prompt/);
});
(0, node_test_1.test)('buildInvokeAgentRequest threads machineId through to context.machineId', () => {
    const withId = (0, invokeAgent_1.buildInvokeAgentRequest)('alice@example.com', 'agent-a', 'hello', session, 0, undefined, 'machine-xyz');
    strict_1.default.equal(withId.context.machineId, 'machine-xyz');
    const withoutId = (0, invokeAgent_1.buildInvokeAgentRequest)('alice@example.com', 'agent-a', 'hello', session);
    strict_1.default.equal(withoutId.context.machineId, '');
});
