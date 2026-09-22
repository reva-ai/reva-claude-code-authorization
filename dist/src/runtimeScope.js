"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isOutsideCodeScope = isOutsideCodeScope;
exports.skipOutsideCodeScope = skipOutsideCodeScope;
const debug_1 = require("./debug");
// These are host runtime signals, not tool names or workspace paths. Desktop
// 2.110.1 launches its local-agent Chat/Cowork runtime with "local-agent" and
// CLAUDE_CODE_IS_COWORK=1; its Code runtime uses "claude-desktop" or
// "claude-desktop-3p". Remote Cowork uses the other two entrypoints below.
// See docs/DESKTOP-COMPATIBILITY.md for evidence and the compatibility limits.
const COWORK_ENTRYPOINTS = new Set(['local-agent', 'remote_cowork', 'remote_cowork_trigger']);
function isOutsideCodeScope(env = process.env) {
    const entrypoint = env.CLAUDE_CODE_ENTRYPOINT;
    if (entrypoint) {
        // A specific Code (or unknown) entrypoint must not be exempted by an
        // inherited Cowork flag, e.g. a CLI launched from inside Cowork.
        return COWORK_ENTRYPOINTS.has(entrypoint);
    }
    // Accept the explicit product flag when the host provides no entrypoint.
    // Missing/unknown signals otherwise preserve Code enforcement.
    return env.CLAUDE_CODE_IS_COWORK === '1';
}
function skipOutsideCodeScope() {
    if (!isOutsideCodeScope())
        return false;
    // No payload, credentials, filesystem state, or explicit allow decision.
    // stdout stays empty so the host retains its native permission behavior.
    (0, debug_1.debugLog)('scope: skipping Chat/Cowork runtime; Claude Code authorization is not applicable');
    return true;
}
