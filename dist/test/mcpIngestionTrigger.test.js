"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const mcpIngestionTrigger_1 = require("../src/mcpIngestionTrigger");
(0, node_test_1.test)('triggerMcpDiscoveryIfDue does nothing when not due — no record, no spawn', () => {
    let recorded = false;
    let spawned = false;
    (0, mcpIngestionTrigger_1.triggerMcpDiscoveryIfDue)('/some/cwd', 'plugin-data-dir', () => false, () => {
        recorded = true;
    }, () => {
        spawned = true;
    });
    strict_1.default.equal(recorded, false);
    strict_1.default.equal(spawned, false);
});
(0, node_test_1.test)('triggerMcpDiscoveryIfDue records the trigger, then spawns, when due', () => {
    const calls = [];
    let spawnArgs;
    (0, mcpIngestionTrigger_1.triggerMcpDiscoveryIfDue)('/some/cwd', 'plugin-data-dir', () => true, () => {
        calls.push('recorded');
    }, (cwd, pluginDataDir) => {
        calls.push('spawned');
        spawnArgs = { cwd, pluginDataDir };
    });
    // Recorded before spawned — a burst of calls in the same window must see
    // the record from the first one, not race each other into spawning twice.
    strict_1.default.deepEqual(calls, ['recorded', 'spawned']);
    strict_1.default.deepEqual(spawnArgs, { cwd: '/some/cwd', pluginDataDir: 'plugin-data-dir' });
});
(0, node_test_1.test)('triggerMcpDiscoveryIfDue passes pluginDataDir through to isDue/recordTriggered, cwd only to spawn', () => {
    const isDueArgs = [];
    const recordArgs = [];
    (0, mcpIngestionTrigger_1.triggerMcpDiscoveryIfDue)('/some/cwd', 'plugin-data-dir', (pluginDataDir) => {
        isDueArgs.push(pluginDataDir);
        return true;
    }, (pluginDataDir) => {
        recordArgs.push(pluginDataDir);
    }, () => { });
    strict_1.default.deepEqual(isDueArgs, ['plugin-data-dir']);
    strict_1.default.deepEqual(recordArgs, ['plugin-data-dir']);
});
// --- ingest-on-invoke -------------------------------------------------------
// Called from the PreToolUse path for an MCP tool call. The common case — a
// server already ingested — must cost one known-name check and nothing else,
// because this runs before every single MCP tool call.
(0, node_test_1.test)('triggerMcpIngestionForInvokedServer does nothing for a server already ingested', () => {
    const calls = [];
    let dueChecked = false;
    (0, mcpIngestionTrigger_1.triggerMcpIngestionForInvokedServer)('gmail', '/repo', '/data', () => true, // known
    () => {
        dueChecked = true;
        return true;
    }, () => calls.push('record'), () => calls.push('spawn'));
    strict_1.default.deepEqual(calls, []);
    // The known check must short-circuit BEFORE the throttle read — this is
    // the hot path for every MCP tool call on an already-ingested server.
    strict_1.default.equal(dueChecked, false);
});
(0, node_test_1.test)('triggerMcpIngestionForInvokedServer records then spawns for an unknown server', () => {
    const calls = [];
    (0, mcpIngestionTrigger_1.triggerMcpIngestionForInvokedServer)('brand-new-server', '/repo', '/data', () => false, () => true, () => calls.push('record'), () => calls.push('spawn'));
    // Recorded before spawning, same ordering as the periodic trigger: a burst
    // of calls to the same still-unknown server can't each spawn their own
    // overlapping child.
    strict_1.default.deepEqual(calls, ['record', 'spawn']);
});
(0, node_test_1.test)('triggerMcpIngestionForInvokedServer respects the throttle for an unknown server', () => {
    const calls = [];
    (0, mcpIngestionTrigger_1.triggerMcpIngestionForInvokedServer)('brand-new-server', '/repo', '/data', () => false, () => false, // a pass was triggered moments ago
    () => calls.push('record'), () => calls.push('spawn'));
    strict_1.default.deepEqual(calls, []);
});
(0, node_test_1.test)('triggerMcpIngestionForInvokedServer ignores an empty server name', () => {
    const calls = [];
    (0, mcpIngestionTrigger_1.triggerMcpIngestionForInvokedServer)('', '/repo', '/data', () => false, () => true, () => calls.push('record'), () => calls.push('spawn'));
    strict_1.default.deepEqual(calls, []);
});
(0, node_test_1.test)('triggerMcpIngestionForInvokedServer passes the server name and pluginDataDir through, cwd only to spawn', () => {
    const seen = {};
    (0, mcpIngestionTrigger_1.triggerMcpIngestionForInvokedServer)('google-calendar', '/some/cwd', '/some/data', (name, dir) => {
        seen.knownName = name;
        seen.knownDir = dir;
        return false;
    }, (dir) => {
        seen.dueDir = dir;
        return true;
    }, (dir) => {
        seen.recordDir = dir;
    }, (cwd, dir) => {
        seen.spawnCwd = cwd;
        seen.spawnDir = dir;
    });
    strict_1.default.equal(seen.knownName, 'google-calendar');
    strict_1.default.equal(seen.knownDir, '/some/data');
    strict_1.default.equal(seen.dueDir, '/some/data');
    strict_1.default.equal(seen.recordDir, '/some/data');
    strict_1.default.equal(seen.spawnCwd, '/some/cwd');
    strict_1.default.equal(seen.spawnDir, '/some/data');
});
(0, node_test_1.test)('the invoked server name is handed to the spawned child — not just a bare discovery re-run', () => {
    // The bug this exists to prevent: the spawn used to pass only cwd, so the
    // child re-ran discovery and found nothing new for a server that lives in
    // no config file. The trigger fired and ingested nothing, every time.
    const seen = {};
    (0, mcpIngestionTrigger_1.triggerMcpIngestionForInvokedServer)('claude-browser', '/some/cwd', '/some/data', () => false, () => true, () => { }, (cwd, dir, invokedServer) => {
        seen.cwd = cwd;
        seen.dir = dir;
        seen.invokedServer = invokedServer;
    });
    strict_1.default.equal(seen.invokedServer, 'claude-browser', 'the child must be told WHICH server was invoked');
    strict_1.default.equal(seen.cwd, '/some/cwd');
    strict_1.default.equal(seen.dir, '/some/data');
});
