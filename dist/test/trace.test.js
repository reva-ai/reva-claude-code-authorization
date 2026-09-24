"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const trace_1 = require("../src/trace");
const TOOL_KEY = 'tool:Bash:{"command":"npm test"}';
const OTHER_KEY = 'tool:Bash:{"command":"npm run build"}';
(0, node_test_1.test)('a minted trace id is a fresh, well-formed W3C trace id every time', () => {
    const a = (0, trace_1.mintTraceId)();
    const b = (0, trace_1.mintTraceId)();
    strict_1.default.match(a, /^[0-9a-f]{32}$/);
    strict_1.default.match(b, /^[0-9a-f]{32}$/);
    // One trace per PROMPT — the next prompt must not reuse this one.
    strict_1.default.notEqual(a, b);
});
(0, node_test_1.test)('a derived span id is a well-formed W3C span id', () => {
    strict_1.default.match((0, trace_1.deriveSpanId)((0, trace_1.mintTraceId)(), TOOL_KEY), /^[0-9a-f]{16}$/);
});
(0, node_test_1.test)('PreToolUse and PostToolUse of ONE tool call land on the same span', () => {
    // The whole reason the span is derived rather than random: the two hooks
    // are separate processes with no shared state, but both see identical
    // tool_name and tool_input, so both compute the same span.
    const traceId = (0, trace_1.mintTraceId)();
    strict_1.default.equal((0, trace_1.deriveSpanId)(traceId, TOOL_KEY), (0, trace_1.deriveSpanId)(traceId, TOOL_KEY));
});
(0, node_test_1.test)('different tool calls in the same turn get different spans, under one trace', () => {
    const traceId = (0, trace_1.mintTraceId)();
    const first = (0, trace_1.deriveSpanId)(traceId, TOOL_KEY);
    const second = (0, trace_1.deriveSpanId)(traceId, OTHER_KEY);
    const prompt = (0, trace_1.deriveSpanId)(traceId, 'user-prompt');
    strict_1.default.notEqual(first, second);
    strict_1.default.notEqual(first, prompt);
    strict_1.default.notEqual(second, prompt);
    // …all three still on the one trace for this prompt.
    for (const span of [first, second, prompt]) {
        strict_1.default.equal((0, trace_1.traceparentHeader)(traceId, span).split('-')[1], traceId);
    }
});
(0, node_test_1.test)('the same tool call under a DIFFERENT turn gets a different span', () => {
    // Spans are scoped by trace, so an identical command in the next prompt is
    // a new span rather than colliding with the previous turn's.
    strict_1.default.notEqual((0, trace_1.deriveSpanId)((0, trace_1.mintTraceId)(), TOOL_KEY), (0, trace_1.deriveSpanId)((0, trace_1.mintTraceId)(), TOOL_KEY));
});
(0, node_test_1.test)('the fallback trace id is stable per (session, turn) and differs across turns', () => {
    // Separate hook processes must agree without the cache, so this has to be
    // deterministic — and turn 2 must not reuse turn 1's trace.
    strict_1.default.equal((0, trace_1.deriveTraceId)('sess-1', 1), (0, trace_1.deriveTraceId)('sess-1', 1));
    strict_1.default.match((0, trace_1.deriveTraceId)('sess-1', 1), /^[0-9a-f]{32}$/);
    strict_1.default.notEqual((0, trace_1.deriveTraceId)('sess-1', 1), (0, trace_1.deriveTraceId)('sess-1', 2));
    strict_1.default.notEqual((0, trace_1.deriveTraceId)('sess-1', 1), (0, trace_1.deriveTraceId)('sess-2', 1));
});
(0, node_test_1.test)('traceparent is assembled in W3C order: version-trace-span-flags', () => {
    const traceId = (0, trace_1.mintTraceId)();
    const spanId = (0, trace_1.deriveSpanId)(traceId, TOOL_KEY);
    strict_1.default.equal((0, trace_1.traceparentHeader)(traceId, spanId), `00-${traceId}-${spanId}-01`);
});
(0, node_test_1.test)('session.id defaults to sessionId, or uses the explicit id if given', () => {
    const traceId = (0, trace_1.mintTraceId)();
    const noId = (0, trace_1.buildSessionContext)('sess-1', 'span-1', traceId);
    strict_1.default.equal(noId.id, 'sess-1');
    strict_1.default.equal(noId.traceId, traceId);
    const withId = (0, trace_1.buildSessionContext)('sess-1', 'span-1', traceId, 'prompt-xyz');
    strict_1.default.equal(withId.id, 'prompt-xyz');
});
