"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const assistantOutput_1 = require("./assistantOutput");
const config_1 = require("./config");
const debug_1 = require("./debug");
const rtgClient_1 = require("./rtgClient");
const runtimeScope_1 = require("./runtimeScope");
const stdin_1 = require("./stdin");
const turnCache_1 = require("./turnCache");
async function main() {
    if ((0, runtimeScope_1.skipOutsideCodeScope)())
        return;
    const raw = await (0, stdin_1.readStdin)();
    const input = JSON.parse(raw);
    const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
    try {
        const cfg = (0, config_1.loadConfig)();
        const turn = (0, turnCache_1.loadTurn)(input.session_id, pluginDataDir);
        if (!turn) {
            (0, debug_1.debugLog)('stop: skip summarize — no turn cache entry');
            process.exit(0);
        }
        const output = (0, assistantOutput_1.resolveAssistantOutput)({
            lastAssistantMessage: input.last_assistant_message,
            transcriptPath: input.transcript_path,
        });
        if (!output)
            (0, debug_1.debugLog)('stop: no assistant output available for summarize');
        const traceId = (0, turnCache_1.resolveTurnTraceId)(input.session_id, turn);
        const result = await (0, rtgClient_1.summarizeTrace)(cfg, {
            trace_id: traceId,
            thread_id: input.session_id,
            ...(output ? { output } : {}),
        });
        if (result.ok) {
            (0, debug_1.debugLog)(`stop: summarize accepted for trace_id=${traceId} output_bytes=${Buffer.byteLength(output || '', 'utf8')}`);
        }
        else {
            (0, debug_1.debugLog)(`stop: summarize failed status=${result.status ?? 'n/a'} reason=${result.reason || 'unknown'}`);
        }
    }
    catch (err) {
        (0, debug_1.debugLog)(`stop: unexpected error — continuing (${err?.message || String(err)})`);
    }
    process.exit(0);
}
main().catch(() => process.exit(0));
