"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const runtimeScope_1 = require("./runtimeScope");
const stdin_1 = require("./stdin");
async function main() {
    if ((0, runtimeScope_1.skipOutsideCodeScope)())
        return;
    const raw = await (0, stdin_1.readStdin)();
    const input = JSON.parse(raw);
    const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
    // Resolved independently of loadConfig() — same reasoning as
    // sessionStart.ts's own active-session tracking: this is local
    // bookkeeping only, so it shouldn't need the auth token (or anything
    // else loadConfig() requires) to succeed first.
    const agentId = process.env.REVA_AGENT_ID || (0, deviceId_1.resolveAgentId)();
    if (!agentId) {
        (0, debug_1.debugLog)('sessionEnd: skipped — no Anthropic account logged in and REVA_AGENT_ID not set');
    }
    else {
        try {
            (0, activeSessions_1.markSessionInactive)(agentId, input.session_id, pluginDataDir);
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionEnd: markSessionInactive failed — ${err?.message || String(err)}`);
        }
    }
    process.exit(0); // clean no-op pass-through — no stdout, nothing to block on
}
main().catch(() => process.exit(0));
