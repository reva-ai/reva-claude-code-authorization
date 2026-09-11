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
const http = __importStar(require("node:http"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_test_1 = require("node:test");
async function runPreToolHook(status, body, dataDir) {
    const server = http.createServer((_req, res) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    strict_1.default.ok(address && typeof address === 'object');
    try {
        const hookPath = path.resolve(__dirname, '../src/authorize.js');
        const child = (0, node_child_process_1.spawn)(process.execPath, [hookPath], {
            env: {
                ...process.env,
                REVA_HOST: `http://127.0.0.1:${address.port}`,
                REVA_AUTH_TOKEN: 'test-token',
                // HOME is redirected to the fresh temp dataDir below, so there's no
                // real ~/.claude.json for this subprocess to read — resolveAgentId()
                // has no fallback (see deviceId.ts), so REVA_AGENT_ID must be set
                // explicitly here the same way REVA_AUTH_TOKEN already is.
                REVA_AGENT_ID: 'hook-test-agent',
                CLAUDE_PLUGIN_DATA: dataDir,
                HOME: dataDir,
                USER: 'hook-test-user',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
        child.stdin.end(JSON.stringify({
            session_id: `session-${status}`,
            cwd: dataDir,
            tool_name: 'Read',
            tool_input: { file_path: path.join(dataDir, 'example.txt') },
        }));
        return await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', (code) => resolve({ code, stdout, stderr }));
        });
    }
    finally {
        await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
}
(0, node_test_1.test)('PreToolUse emits no decision while 401/5xx inactivity circuits are open', async (t) => {
    for (const [status, body] of [
        [401, { decision: false, error_type: 'USER_DISABLED' }],
        [503, { decision: false, error_type: 'POLICY_ENGINE_UNAVAILABLE' }],
    ]) {
        await t.test(`HTTP ${status}`, async (t) => {
            const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `reva-hook-${status}-`));
            t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
            const result = await runPreToolHook(status, body, dataDir);
            strict_1.default.equal(result.code, 0, result.stderr);
            strict_1.default.equal(result.stdout, '');
        });
    }
});
(0, node_test_1.test)('PreToolUse still emits allow for 200 and deny for 403', async (t) => {
    for (const [status, body, expected] of [
        [200, { decision: true }, 'allow'],
        [403, { decision: false, error_type: 'POLICY_DENIED', context: { reason: 'denied' } }, 'deny'],
    ]) {
        await t.test(`HTTP ${status}`, async (t) => {
            const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `reva-hook-${status}-`));
            t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
            const result = await runPreToolHook(status, body, dataDir);
            strict_1.default.equal(result.code, 0, result.stderr);
            const output = JSON.parse(result.stdout);
            strict_1.default.equal(output.hookSpecificOutput.permissionDecision, expected);
        });
    }
});
