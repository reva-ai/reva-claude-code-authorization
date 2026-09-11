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
const path = __importStar(require("node:path"));
const node_test_1 = require("node:test");
// SessionStart has no blocking/decision control at all — sessionStart.ts
// must always exit 0 with empty stdout, no matter what. Exercised as a real
// subprocess (not a unit test of internal functions) because the contract
// that actually matters here is the process's exit code and stdout, which
// is exactly what Claude Code itself observes.
//
// Runs with a deliberately clean, minimal env — no REVA_AUTH_TOKEN —
// so this never makes a real network call
// regardless of what's set in the developer's own shell.
const ENTRYPOINT = path.join(__dirname, '..', 'src', 'sessionStart.js');
const CLEAN_ENV = { PATH: process.env.PATH || '' };
function runSessionStart(stdin) {
    const result = (0, node_child_process_1.spawnSync)(process.execPath, [ENTRYPOINT], {
        input: stdin,
        env: CLEAN_ENV,
        encoding: 'utf8',
        timeout: 5000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
(0, node_test_1.test)('valid input, plugin not configured at all: exits 0 with empty stdout', () => {
    const { status, stdout } = runSessionStart(JSON.stringify({ session_id: 's1', cwd: '/tmp', source: 'startup' }));
    strict_1.default.equal(status, 0);
    strict_1.default.equal(stdout, '');
});
(0, node_test_1.test)('malformed JSON on stdin: still exits 0 with empty stdout, never throws uncaught', () => {
    const { status, stdout } = runSessionStart('{ not valid json');
    strict_1.default.equal(status, 0);
    strict_1.default.equal(stdout, '');
});
(0, node_test_1.test)('empty stdin: still exits 0 with empty stdout', () => {
    const { status, stdout } = runSessionStart('');
    strict_1.default.equal(status, 0);
    strict_1.default.equal(stdout, '');
});
(0, node_test_1.test)('missing fields entirely (bare {}): still exits 0 with empty stdout', () => {
    const { status, stdout } = runSessionStart('{}');
    strict_1.default.equal(status, 0);
    strict_1.default.equal(stdout, '');
});
