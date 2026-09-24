"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.spawnMcpIngestion = spawnMcpIngestion;
exports.triggerMcpDiscoveryIfDue = triggerMcpDiscoveryIfDue;
exports.triggerMcpIngestionForInvokedServer = triggerMcpIngestionForInvokedServer;
const node_child_process_1 = require("node:child_process");
const path = __importStar(require("node:path"));
const debug_1 = require("./debug");
const ingestionClient_1 = require("./ingestionClient");
// Spawns ingestMcpServers.ts as a fully detached, unref'd child. Callers
// (sessionStart.ts, unconditionally every session; authorizePrompt.ts, via
// triggerMcpDiscoveryIfDue below) never wait on it, so however long
// discovery+ingestion takes, or however it fails, cannot block them.
//
// stdio is 'ignore' — no need to redirect it anywhere: debugLog (debug.ts)
// already writes REVA_DEBUG=1 output straight to CLAUDE_PLUGIN_DATA/debug.log
// itself now, so this detached child's own debug lines land there the same
// way every other hook's do, without this file needing to manage a
// dedicated log file or file descriptor for it.
function spawnMcpIngestion(cwd, pluginDataDir, invokedServer) {
    try {
        const child = (0, node_child_process_1.spawn)(process.execPath, [path.join(__dirname, 'ingestMcpServers.js')], {
            detached: true,
            stdio: 'ignore',
            env: {
                ...process.env,
                REVA_SESSION_CWD: cwd,
                // The server whose tool was just invoked, when this spawn came from
                // the PreToolUse path. Without it the child only re-runs DISCOVERY,
                // which by definition finds nothing new for a server that lives in
                // no config file — so an app-provided server (Claude_Browser,
                // claude-in-chrome, the iOS simulator) triggered a pass that ingested
                // nothing, every time. Observed directly: the trigger fired for an
                // app-provided server, the child ran, and the name was still absent
                // afterwards.
                ...(invokedServer ? { REVA_INVOKED_MCP_SERVER: invokedServer } : {}),
            },
        });
        child.on('error', (err) => (0, debug_1.debugLog)(`spawnMcpIngestion: spawn error — ${err?.message || String(err)}`));
        child.unref();
    }
    catch (err) {
        (0, debug_1.debugLog)(`spawnMcpIngestion: failed to spawn ingestMcpServers — ${err?.message || String(err)}`);
    }
}
// UserPromptSubmit fires every turn — unlike SessionStart, which always
// triggers a pass once per session, this only re-triggers if it's actually
// due (see ingestionClient.ts's isMcpDiscoveryDue), so a connector added
// mid-session is picked up again within ~15 minutes instead of only at the
// next SessionStart. "Due" is recorded before spawning, not after
// completion, so a burst of turns inside that window can't each spawn
// their own overlapping pass.
//
// Dependencies are injectable (defaulting to the real ones) purely for
// tests — real callers always use the defaults.
function triggerMcpDiscoveryIfDue(cwd, pluginDataDir, isDue = ingestionClient_1.isMcpDiscoveryDue, recordTriggered = ingestionClient_1.recordMcpDiscoveryTriggered, spawnIngestion = spawnMcpIngestion) {
    if (!isDue(pluginDataDir))
        return;
    recordTriggered(pluginDataDir);
    spawnIngestion(cwd, pluginDataDir);
}
// Ingest-on-invoke: an MCP server whose tool is actually being called, but
// which no discovery pass has ingested yet, gets one triggered immediately
// rather than waiting for the next recheck.
//
// Its unique value is servers NO file source sees: the app-provided ones
// (Claude_Browser, claude-in-chrome, the iOS simulator), a plugin's own
// bundled server, and whatever shape the app introduces next. Invocation is
// the only evidence those exist, so it is the only way they can ever be
// inventoried.
//
// That value was claimed in an earlier version of this comment but not
// actually delivered: the spawn passed only cwd, so the child re-ran
// discovery and found exactly nothing new for precisely those servers. The
// invoked name is now passed through and ingested directly.
//
// Called from the PreToolUse path, so the ordering matters: the known-name
// check runs first and costs one cached read, the spawn is detached and
// never awaited, and the whole thing is wrapped by its caller. Nothing here
// may block or fail an authorization decision.
function triggerMcpIngestionForInvokedServer(serverName, cwd, pluginDataDir, isKnown = ingestionClient_1.isMcpServerKnown, isDue = ingestionClient_1.isMcpInvokeIngestDue, recordTriggered = ingestionClient_1.recordMcpInvokeIngestTriggered, spawnIngestion = spawnMcpIngestion) {
    if (!serverName)
        return;
    // Dedup only — "have we already ingested this name", NOT "is it
    // discoverable". The name is handed to the child below and ingested on its
    // own merit, so a server that no config file mentions still gets recorded.
    if (isKnown(serverName, pluginDataDir))
        return;
    if (!isDue(pluginDataDir))
        return;
    recordTriggered(pluginDataDir);
    spawnIngestion(cwd, pluginDataDir, serverName);
}
