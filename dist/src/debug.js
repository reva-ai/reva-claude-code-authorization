"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.debugLog = debugLog;
// Opt-in via REVA_DEBUG=1. Writes to stderr only — stdout is reserved for
// the hook's JSON decision, so this never interferes with parsing.
function debugLog(message) {
    if (process.env.REVA_DEBUG) {
        process.stderr.write(`[reva-governance] ${message}\n`);
    }
}
