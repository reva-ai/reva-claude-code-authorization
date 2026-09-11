"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const trace_1 = require("../src/trace");
(0, node_test_1.test)('same session_id + spanId always produces the identical traceparent', () => {
    const a = (0, trace_1.buildSessionContext)('sess-1', 'span-1');
    const b = (0, trace_1.buildSessionContext)('sess-1', 'span-1');
    strict_1.default.equal(a.traceId, b.traceId);
    strict_1.default.equal(a.spanId, b.spanId);
    strict_1.default.equal((0, trace_1.traceparentHeader)(a.traceId, a.spanId), (0, trace_1.traceparentHeader)(b.traceId, b.spanId));
});
(0, node_test_1.test)('same session, different spanId (turn): same traceId (session), different spanId', () => {
    const turn1 = (0, trace_1.buildSessionContext)('sess-1', 'span-1');
    const turn2 = (0, trace_1.buildSessionContext)('sess-1', 'span-2');
    strict_1.default.equal(turn1.traceId, turn2.traceId);
    strict_1.default.notEqual(turn1.spanId, turn2.spanId);
});
(0, node_test_1.test)('different session_id produces a different traceId', () => {
    strict_1.default.notEqual((0, trace_1.buildTraceId)('sess-1'), (0, trace_1.buildTraceId)('sess-2'));
});
(0, node_test_1.test)('buildTraceId is deterministic', () => {
    strict_1.default.equal((0, trace_1.buildTraceId)('sess-1'), (0, trace_1.buildTraceId)('sess-1'));
});
(0, node_test_1.test)('session.id defaults to sessionId, or uses the explicit id if given', () => {
    const noId = (0, trace_1.buildSessionContext)('sess-1', 'span-1');
    strict_1.default.equal(noId.id, 'sess-1');
    const withId = (0, trace_1.buildSessionContext)('sess-1', 'span-1', 'prompt-xyz');
    strict_1.default.equal(withId.id, 'prompt-xyz');
});
