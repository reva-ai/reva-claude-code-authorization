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
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_test_1 = require("node:test");
const activeSessions_1 = require("../src/activeSessions");
// SessionEnd has no blocking/decision control at all — sessionEnd.ts must
// always exit 0 with empty stdout, no matter what. Exercised as a real
// subprocess (not a unit test of internal functions) for the resilience
// cases, since the contract that matters there is the process's exit code
// and stdout, exactly what Claude Code itself observes — same rationale as
// sessionStart.test.ts.
const ENTRYPOINT = path.join(__dirname, '..', 'src', 'sessionEnd.js');
function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-session-end-'));
    try {
        fn(dir);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
function runSessionEnd(stdin, env = {}) {
    const result = (0, node_child_process_1.spawnSync)(process.execPath, [ENTRYPOINT], {
        input: stdin,
        env: { PATH: process.env.PATH || '', ...env },
        encoding: 'utf8',
        timeout: 5000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
(0, node_test_1.test)('valid input, no REVA_AGENT_ID and no logged-in account: exits 0 with empty stdout', () => {
    const { status, stdout } = runSessionEnd(JSON.stringify({ session_id: 's1', cwd: '/tmp' }));
    strict_1.default.equal(status, 0);
    strict_1.default.equal(stdout, '');
});
(0, node_test_1.test)('malformed JSON on stdin: still exits 0 with empty stdout, never throws uncaught', () => {
    const { status, stdout } = runSessionEnd('{ not valid json');
    strict_1.default.equal(status, 0);
    strict_1.default.equal(stdout, '');
});
(0, node_test_1.test)('empty stdin: still exits 0 with empty stdout', () => {
    const { status, stdout } = runSessionEnd('');
    strict_1.default.equal(status, 0);
    strict_1.default.equal(stdout, '');
});
(0, node_test_1.test)('missing fields entirely (bare {}): still exits 0 with empty stdout', () => {
    const { status, stdout } = runSessionEnd('{}');
    strict_1.default.equal(status, 0);
    strict_1.default.equal(stdout, '');
});
(0, node_test_1.test)('a real SessionEnd removes the session from the active-sessions registry, not just exits cleanly', () => {
    withTempDir((dir) => {
        (0, activeSessions_1.markSessionActive)('agent-real', 'sess-1', 'cli', dir);
        strict_1.default.equal((0, activeSessions_1.getActiveSessionCount)('agent-real', dir), 1);
        const { status } = runSessionEnd(JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' }), {
            REVA_AGENT_ID: 'agent-real',
            CLAUDE_PLUGIN_DATA: dir,
        });
        strict_1.default.equal(status, 0);
        strict_1.default.equal((0, activeSessions_1.getActiveSessionCount)('agent-real', dir), 0);
    });
});
(0, node_test_1.test)('SessionEnd for one session leaves a different concurrent session untouched', () => {
    withTempDir((dir) => {
        (0, activeSessions_1.markSessionActive)('agent-real', 'sess-1', 'cli', dir);
        (0, activeSessions_1.markSessionActive)('agent-real', 'sess-2', 'claude-desktop', dir);
        strict_1.default.equal((0, activeSessions_1.getActiveSessionCount)('agent-real', dir), 2);
        runSessionEnd(JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' }), {
            REVA_AGENT_ID: 'agent-real',
            CLAUDE_PLUGIN_DATA: dir,
        });
        strict_1.default.equal((0, activeSessions_1.getActiveSessionCount)('agent-real', dir), 1);
    });
});
