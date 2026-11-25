"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const config_1 = require("./config");
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const identity_1 = require("./identity");
const invokeAgent_1 = require("./invokeAgent");
const mcpIngestionTrigger_1 = require("./mcpIngestionTrigger");
const pluginVersionGate_1 = require("./pluginVersionGate");
const rtgClient_1 = require("./rtgClient");
const runtimeScope_1 = require("./runtimeScope");
const sessionModel_1 = require("./sessionModel");
const spawnCounter_1 = require("./spawnCounter");
const stdin_1 = require("./stdin");
const trace_1 = require("./trace");
const turnCache_1 = require("./turnCache");
// UserPromptSubmit uses a different, binary output schema than PreToolUse
// (top-level decision:"block" vs hookSpecificOutput.permissionDecision).
// The direct-AI client is status-authoritative: 200 passes and blocking
// policy/input statuses return deny.
function writeDecision(result) {
    if (result.inactive) {
        // No output means the Reva hook is inactive and Claude continues with its
        // native behavior; an explicit allow/block would still enforce a choice.
    }
    else if (result.decision === 'deny') {
        process.stdout.write(JSON.stringify({
            decision: 'block',
            reason: result.reason || "Blocked by your organization's security policy.",
        }));
    }
    else if (result.decision === 'ask') {
        process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: `Reva governance: this session requires elevated review (${result.reason || 'conditional policy match'}); individual tool calls will still be evaluated.`,
            },
        }));
    }
    process.exit(0);
}
async function main() {
    if ((0, runtimeScope_1.skipOutsideCodeScope)())
        return;
    const raw = await (0, stdin_1.readStdin)();
    const input = JSON.parse(raw);
    const cfg = (0, config_1.loadConfig)();
    const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
    // SessionStart latches an outdated plugin. Block the turn here (decision:
    // block) before evaluate so the model never runs on a version-blocked
    // session.
    const versionGate = (0, pluginVersionGate_1.readPluginVersionGate)(input.session_id, pluginDataDir);
    if (versionGate.status === 'blocked') {
        (0, debug_1.debugLog)(`UserPromptSubmit: plugin version blocked — ${versionGate.reason}`);
        writeDecision({
            decision: 'deny',
            reason: versionGate.reason,
            errorType: versionGate.errorType,
            status: 403,
        });
    }
    // Closes the gap between SessionStart's once-per-session discovery pass
    // and a connector added mid-session: UserPromptSubmit fires every turn,
    // so re-checking here (throttled to ~15 minutes, see
    // mcpIngestionTrigger.ts) picks up a new connector well before the next
    // SessionStart would. A no-op, non-blocking cache read when not yet due.
    (0, mcpIngestionTrigger_1.triggerMcpDiscoveryIfDue)(input.cwd, pluginDataDir);
    const userEmail = (0, identity_1.resolveUserEmail)();
    // The cleaned prompt goes to Reva as the invokeAgent userQuery and nowhere
    // else: it is not kept on this machine.
    const submittedPrompt = input.prompt ? (0, turnCache_1.cleanSubmittedPrompt)(input.prompt) : '';
    const prompt = submittedPrompt ? (0, turnCache_1.truncatePrompt)(submittedPrompt) : '';
    // UserPromptSubmit fires every turn, unlike SessionStart (once per
    // session) — a good second place to keep this session's lastSeen fresh.
    const currentSession = (0, activeSessions_1.markSessionActive)(cfg.agentId, input.session_id, process.env.CLAUDE_CODE_ENTRYPOINT || 'unknown', pluginDataDir);
    const activeSessionCount = (0, activeSessions_1.getActiveSessionCount)(cfg.agentId, pluginDataDir);
    // This plugin owns the turn boundary itself: mint a fresh trace id here
    // and persist it (id and turn number only, no prompt text) so every
    // PreToolUse call this turn produces — separate, stateless hook
    // processes — reads the same value back instead of each rolling its own.
    const turn = (0, turnCache_1.startTurn)(input.session_id, pluginDataDir);
    // Same turn boundary resets the subagent spawn counter — each turn's
    // first spawn is #1 again, not a continuation of every prior turn's
    // count (see spawnCounter.ts's own comment on why).
    (0, spawnCounter_1.resetSpawnCounter)(input.session_id, pluginDataDir);
    // This hook opens the turn, so its trace id is the one every tool call in
    // the turn will read back. Its own span is the prompt evaluation itself.
    const traceId = (0, turnCache_1.resolveTurnTraceId)(input.session_id, turn);
    const spanId = (0, trace_1.deriveSpanId)(traceId, 'user-prompt');
    const traceSession = (0, trace_1.buildSessionContext)(input.session_id, spanId, traceId, input.prompt_id);
    const traceparent = (0, trace_1.traceparentHeader)(traceSession.traceId, traceSession.spanId);
    // The model this session is running on — see sessionModel.ts. Best-effort:
    // resolveSessionModel never throws, and an unknown model is just omitted.
    const sessionModel = cfg.modelContext
        ? (0, sessionModel_1.resolveSessionModel)(input.session_id, input.transcript_path, pluginDataDir)
        : undefined;
    const request = (0, invokeAgent_1.buildInvokeAgentRequest)(userEmail, cfg.agentId, prompt, (0, turnCache_1.directSessionFromTurn)(input.session_id), activeSessionCount, currentSession, (0, deviceId_1.resolveMachineId)(pluginDataDir), sessionModel?.model);
    (0, debug_1.debugLog)(`-> invokeAgent as ${userEmail} on Agent:${cfg.agentId} (model=${sessionModel ? `${sessionModel.model ?? 'unknown'} via ${sessionModel.source}` : 'off'})`);
    const result = await (0, rtgClient_1.evaluate)(cfg, request, traceparent, pluginDataDir, input.session_id);
    (0, debug_1.debugLog)(`<- decision=${result.decision}${result.reason ? ` reason="${result.reason}"` : ''}`);
    // Hops are recorded by RTG from evaluate — do not persist a local hop chain
    // under CLAUDE_PLUGIN_DATA (that used to write hops/*.json on the machine).
    writeDecision(result);
}
main().catch((err) => {
    // The ONLY record this denial leaves. writeDecision exits the process
    // immediately after printing the hook response, so without this line a
    // fail-closed deny is invisible everywhere except the UI toast the user
    // sees — which is exactly why an intermittent config failure looked
    // random and undiagnosable.
    (0, debug_1.debugLog)(`UserPromptSubmit: FAILING CLOSED — ${err?.stack || err?.message || String(err)}`);
    writeDecision({
        decision: 'deny',
        reason: `Reva governance plugin internal error — failing closed (${err?.message || String(err)})`,
    });
});
