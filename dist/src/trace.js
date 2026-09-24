"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mintTraceId = mintTraceId;
exports.deriveTraceId = deriveTraceId;
exports.deriveSpanId = deriveSpanId;
exports.buildSessionContext = buildSessionContext;
exports.traceparentHeader = traceparentHeader;
const node_crypto_1 = require("node:crypto");
// Three distinct identifiers, one per level of the hierarchy. Getting the
// levels right is the whole point:
//
//   thread  — the chat. Claude Code's own session_id, sent as the
//             X-Reva-Thread-Id header on every RTG call. Constant from the
//             first prompt of a conversation to the last; changes only when
//             a new chat is started. Identical whether the session runs from
//             the CLI or the desktop app, since the hook payload carries the
//             CLI session id in both.
//   trace   — one user prompt. Minted per turn (turnCache.startTurn) and
//             read back by every hook in that turn, so a prompt that fans
//             out into many tool calls keeps one trace across all of them.
//             The next prompt gets a new one.
//   span    — one operation inside the turn. Derived, not random, so the
//             PreToolUse and PostToolUse halves of the SAME tool call land
//             on the same span: both hooks see identical tool_name and
//             tool_input, so both compute the same value with no shared
//             state. See deriveSpanId's own note on the collision this
//             accepts.
//
// Before this, traceId was a hash of session_id (constant for the entire
// session) and spanId was minted per turn — the levels were each one step
// too high, and there was no thread header at all.
// 32 hex chars, W3C traceparent trace-id. Random rather than derived: a turn
// has no natural stable key of its own (prompt_id is optional and not
// confirmed identical across every mode), so the plugin mints one and pins
// it in the turn cache, the same approach the span id used to take.
function mintTraceId() {
    return (0, node_crypto_1.randomUUID)().replace(/-/g, '');
}
// Deterministic fallback for a turn whose cache entry predates traceId, or
// that could not be written. Stable for a given (session, turn) so every
// hook in that turn still agrees, without needing a cache write.
function deriveTraceId(sessionId, turn) {
    return (0, node_crypto_1.createHash)('sha256').update(`${sessionId}:turn:${turn}`).digest('hex').slice(0, 32);
}
// 16 hex chars, W3C traceparent parent-id (span). Derived from the trace plus
// a caller-supplied key describing the operation.
//
// The key for a tool call is tool_name + tool_input, which PreToolUse and
// PostToolUse both have and which are identical between them — that is what
// makes the pair share a span without any state passing between the two
// processes. tool_use_id would be the natural key, but Claude Code only
// sends it on PostToolUse, so it cannot pair the two.
//
// Accepted consequence: two genuinely separate calls with identical input in
// one turn (the same bash command run twice) collapse onto one span. They
// stay under the correct trace, so the turn is still whole; they just are not
// distinguishable from each other within it.
function deriveSpanId(traceId, key) {
    return (0, node_crypto_1.createHash)('sha256').update(`${traceId}:${key}`).digest('hex').slice(0, 16);
}
function buildSessionContext(sessionId, spanId, traceId, id) {
    return { id: id || sessionId, traceId, spanId };
}
function traceparentHeader(traceId, spanId) {
    return `00-${traceId}-${spanId}-01`;
}
