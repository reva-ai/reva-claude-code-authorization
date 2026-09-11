"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildTraceId = buildTraceId;
exports.buildSessionContext = buildSessionContext;
exports.traceparentHeader = traceparentHeader;
const node_crypto_1 = require("node:crypto");
// traceId is deterministic per session_id (stable across the many separate
// hook process invocations that make up one Claude Code session). spanId is
// NOT derived here — it's minted once per turn by turnCache.startTurn and
// passed in, so every call within one turn shares the identical traceparent
// and a new turn always gets a new one.
function buildTraceId(sessionId) {
    return (0, node_crypto_1.createHash)('sha256').update(sessionId).digest('hex').slice(0, 32);
}
function buildSessionContext(sessionId, spanId, id) {
    return { id: id || sessionId, traceId: buildTraceId(sessionId), spanId };
}
function traceparentHeader(traceId, spanId) {
    return `00-${traceId}-${spanId}-01`;
}
