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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_test_1 = require("node:test");
const activeSessions_1 = require("../src/activeSessions");
function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-active-sessions-'));
    try {
        fn(dir);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
// Matches activeSessions.ts's own (unexported) cacheFile() convention —
// needed here only to hand-write a stale entry for the pruning test below.
function cacheFile(dir, agentId) {
    return path.join(dir, 'active-sessions', `${agentId}.json`);
}
(0, node_test_1.test)('first session for an Agent is the only one active', () => {
    withTempDir((dir) => {
        (0, activeSessions_1.markSessionActive)('agent-1', 'sess-1', 'cli', dir);
        strict_1.default.equal((0, activeSessions_1.getActiveSessionCount)('agent-1', dir), 1);
    });
});
(0, node_test_1.test)('markSessionActive returns the entry it just wrote, so callers need no separate read', () => {
    withTempDir((dir) => {
        const entry = (0, activeSessions_1.markSessionActive)('agent-1', 'sess-1', 'cli', dir);
        strict_1.default.equal(entry?.sessionId, 'sess-1');
        strict_1.default.equal(entry?.entrypoint, 'cli');
        strict_1.default.ok(entry && entry.lastSeen > 0);
    });
});
(0, node_test_1.test)('markSessionActive returns undefined for an empty sessionId — nothing to report', () => {
    withTempDir((dir) => {
        strict_1.default.equal((0, activeSessions_1.markSessionActive)('agent-1', '', 'cli', dir), undefined);
    });
});
(0, node_test_1.test)('getSessionEntry reads one session back without refreshing it', () => {
    withTempDir((dir) => {
        (0, activeSessions_1.markSessionActive)('agent-1', 'sess-1', 'cli', dir);
        const entry = (0, activeSessions_1.getSessionEntry)('agent-1', 'sess-1', dir);
        strict_1.default.equal(entry?.sessionId, 'sess-1');
        strict_1.default.equal(entry?.entrypoint, 'cli');
    });
});
(0, node_test_1.test)('getSessionEntry returns undefined for a session that was never marked active', () => {
    withTempDir((dir) => {
        (0, activeSessions_1.markSessionActive)('agent-1', 'sess-1', 'cli', dir);
        strict_1.default.equal((0, activeSessions_1.getSessionEntry)('agent-1', 'sess-does-not-exist', dir), undefined);
    });
});
(0, node_test_1.test)('multiple distinct session_ids for the same Agent all count as active', () => {
    withTempDir((dir) => {
        (0, activeSessions_1.markSessionActive)('agent-1', 'sess-1', 'cli', dir);
        (0, activeSessions_1.markSessionActive)('agent-1', 'sess-2', 'claude-desktop', dir);
        strict_1.default.equal((0, activeSessions_1.getActiveSessionCount)('agent-1', dir), 2);
        const sessions = (0, activeSessions_1.getActiveSessions)('agent-1', dir).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
        strict_1.default.equal(sessions[0].sessionId, 'sess-1');
        strict_1.default.equal(sessions[0].entrypoint, 'cli');
        strict_1.default.equal(sessions[1].sessionId, 'sess-2');
        strict_1.default.equal(sessions[1].entrypoint, 'claude-desktop');
        strict_1.default.ok(sessions[0].lastSeen > 0);
    });
});
(0, node_test_1.test)('re-marking the same session_id refreshes it in place, not as a duplicate', () => {
    withTempDir((dir) => {
        (0, activeSessions_1.markSessionActive)('agent-1', 'sess-1', 'cli', dir);
        (0, activeSessions_1.markSessionActive)('agent-1', 'sess-1', 'cli', dir);
        (0, activeSessions_1.markSessionActive)('agent-1', 'sess-1', 'cli', dir);
        strict_1.default.equal((0, activeSessions_1.getActiveSessionCount)('agent-1', dir), 1);
    });
});
(0, node_test_1.test)('different Agents (machines) have independent registries', () => {
    withTempDir((dir) => {
        (0, activeSessions_1.markSessionActive)('agent-1', 'sess-1', 'cli', dir);
        (0, activeSessions_1.markSessionActive)('agent-2', 'sess-2', 'cli', dir);
        strict_1.default.equal((0, activeSessions_1.getActiveSessionCount)('agent-1', dir), 1);
        strict_1.default.equal((0, activeSessions_1.getActiveSessionCount)('agent-2', dir), 1);
    });
});
(0, node_test_1.test)('a session not seen in over 10 minutes is treated as gone', () => {
    withTempDir((dir) => {
        (0, activeSessions_1.markSessionActive)('agent-1', 'sess-fresh', 'cli', dir);
        // Hand-write a second, stale entry directly into the same file — this
        // is what a session looks like after being genuinely abandoned (no
        // SessionEnd hook exists to clean it up any other way).
        const file = cacheFile(dir, 'agent-1');
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        state.sessions['sess-stale'] = { entrypoint: 'cli', lastSeen: Date.now() - 11 * 60 * 1000 };
        fs.writeFileSync(file, JSON.stringify(state), 'utf8');
        const sessions = (0, activeSessions_1.getActiveSessions)('agent-1', dir);
        strict_1.default.deepEqual(sessions.map((s) => s.sessionId), ['sess-fresh']);
    });
});
(0, node_test_1.test)('reading prunes stale entries from disk, not just from the returned result', () => {
    withTempDir((dir) => {
        const file = cacheFile(dir, 'agent-1');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ sessions: { 'sess-old': { entrypoint: 'cli', lastSeen: Date.now() - 24 * 60 * 60 * 1000 } } }), 'utf8');
        // Any call that writes (markSessionActive) re-saves the pruned state.
        (0, activeSessions_1.markSessionActive)('agent-1', 'sess-new', 'cli', dir);
        const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
        strict_1.default.deepEqual(Object.keys(onDisk.sessions), ['sess-new']);
    });
});
(0, node_test_1.test)('markSessionActive ignores an empty/missing sessionId rather than recording a literal "undefined" entry', () => {
    withTempDir((dir) => {
        (0, activeSessions_1.markSessionActive)('agent-1', '', 'cli', dir);
        (0, activeSessions_1.markSessionActive)('agent-1', undefined, 'cli', dir);
        strict_1.default.equal((0, activeSessions_1.getActiveSessionCount)('agent-1', dir), 0);
    });
});
(0, node_test_1.test)('getActiveSessionCount is 0 when nothing has ever been recorded', () => {
    withTempDir((dir) => {
        strict_1.default.equal((0, activeSessions_1.getActiveSessionCount)('never-seen-agent', dir), 0);
        strict_1.default.deepEqual((0, activeSessions_1.getActiveSessions)('never-seen-agent', dir), []);
    });
});
(0, node_test_1.test)('with no pluginDataDir, everything no-ops instead of falling back to a home-directory dotfile', () => {
    const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
    const existedBefore = fs.existsSync(homeRevaGovernance);
    const marked = (0, activeSessions_1.markSessionActive)('agent-1', 'sess-1', 'cli', undefined);
    strict_1.default.equal(marked?.sessionId, 'sess-1'); // still returns a usable entry
    strict_1.default.equal((0, activeSessions_1.getActiveSessionCount)('agent-1', undefined), 0); // but never actually persisted
    strict_1.default.deepEqual((0, activeSessions_1.getActiveSessions)('agent-1', undefined), []);
    strict_1.default.equal((0, activeSessions_1.getSessionEntry)('agent-1', 'sess-1', undefined), undefined);
    // Never created (or re-created) ~/.reva-governance as a side effect.
    strict_1.default.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});
