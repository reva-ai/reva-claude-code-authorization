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
const sessionModel_1 = require("../src/sessionModel");
function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-model-'));
    try {
        fn(dir);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
// Mirrors the real Claude Code transcript JSONL: assistant entries carry
// message.model plus an ISO timestamp; other entry types carry neither.
function writeTranscript(dir, entries) {
    const file = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(file, entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join('\n') + '\n', 'utf8');
    return file;
}
function assistant(model, timestamp, extra = {}) {
    return { type: 'assistant', isSidechain: false, timestamp, message: { role: 'assistant', model, content: [] }, ...extra };
}
(0, node_test_1.test)('normalizeModel trims, and rejects blanks, non-strings and the <synthetic> placeholder', () => {
    strict_1.default.equal((0, sessionModel_1.normalizeModel)('  claude-opus-5-5 '), 'claude-opus-5-5');
    strict_1.default.equal((0, sessionModel_1.normalizeModel)(''), undefined);
    strict_1.default.equal((0, sessionModel_1.normalizeModel)('   '), undefined);
    strict_1.default.equal((0, sessionModel_1.normalizeModel)(undefined), undefined);
    strict_1.default.equal((0, sessionModel_1.normalizeModel)(42), undefined);
    strict_1.default.equal((0, sessionModel_1.normalizeModel)('<synthetic>'), undefined);
});
(0, node_test_1.test)('recordSessionModel round-trips through loadRecordedSessionModel, and clearSessionModel removes it', () => {
    withTempDir((dir) => {
        (0, sessionModel_1.recordSessionModel)('sess-1', 'claude-sonnet-5-5', dir, '2026-11-03T10:00:00.000Z');
        strict_1.default.deepEqual((0, sessionModel_1.loadRecordedSessionModel)('sess-1', dir), {
            model: 'claude-sonnet-5-5',
            observedAt: '2026-11-03T10:00:00.000Z',
        });
        strict_1.default.equal((0, sessionModel_1.loadRecordedSessionModel)('other-session', dir), undefined);
        (0, sessionModel_1.clearSessionModel)('sess-1', dir);
        strict_1.default.equal((0, sessionModel_1.loadRecordedSessionModel)('sess-1', dir), undefined);
    });
});
(0, node_test_1.test)('recordSessionModel is a no-op without CLAUDE_PLUGIN_DATA or without a real model', () => {
    withTempDir((dir) => {
        (0, sessionModel_1.recordSessionModel)('sess-1', 'claude-opus-5-5', undefined);
        (0, sessionModel_1.recordSessionModel)('sess-1', '', dir);
        strict_1.default.equal((0, sessionModel_1.loadRecordedSessionModel)('sess-1', dir), undefined);
        strict_1.default.equal(fs.existsSync(path.join(dir, 'session-models')), false);
    });
});
(0, node_test_1.test)('readLatestTranscriptModel returns the newest main-thread assistant model', () => {
    withTempDir((dir) => {
        const file = writeTranscript(dir, [
            { type: 'user', timestamp: '2026-11-03T10:00:00.000Z', message: { role: 'user', content: 'hi' } },
            assistant('claude-sonnet-5-5', '2026-11-03T10:00:01.000Z'),
            assistant('claude-opus-5-5', '2026-11-03T10:05:00.000Z'),
            // Newer, but must be skipped: a subagent's turn and a synthetic error entry.
            assistant('claude-haiku-5-5', '2026-11-03T10:06:00.000Z', { isSidechain: true }),
            assistant('<synthetic>', '2026-11-03T10:07:00.000Z'),
            { type: 'user', timestamp: '2026-11-03T10:08:00.000Z', message: { role: 'user', content: 'next' } },
            'not json at all',
        ]);
        strict_1.default.deepEqual((0, sessionModel_1.readLatestTranscriptModel)(file), {
            model: 'claude-opus-5-5',
            observedAt: '2026-11-03T10:05:00.000Z',
        });
    });
});
(0, node_test_1.test)('readLatestTranscriptModel returns undefined for a missing or model-less transcript', () => {
    withTempDir((dir) => {
        strict_1.default.equal((0, sessionModel_1.readLatestTranscriptModel)(undefined), undefined);
        strict_1.default.equal((0, sessionModel_1.readLatestTranscriptModel)(path.join(dir, 'missing.jsonl')), undefined);
        const file = writeTranscript(dir, [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
        strict_1.default.equal((0, sessionModel_1.readLatestTranscriptModel)(file), undefined);
    });
});
(0, node_test_1.test)('readLatestTranscriptModel finds the model when only the tail of a large transcript is read', () => {
    withTempDir((dir) => {
        const filler = { type: 'user', message: { role: 'user', content: 'x'.repeat(4096) } };
        const entries = [assistant('claude-sonnet-5-5', '2026-11-03T09:00:00.000Z')];
        for (let i = 0; i < 400; i++)
            entries.push(filler); // ~1.6 MiB, past the tail window
        entries.push(assistant('claude-opus-5-5', '2026-11-03T10:00:00.000Z'));
        const file = writeTranscript(dir, entries);
        strict_1.default.equal((0, sessionModel_1.readLatestTranscriptModel)(file)?.model, 'claude-opus-5-5');
    });
});
(0, node_test_1.test)('resolveSessionModel: SessionStart value only — first prompt of a fresh session', () => {
    withTempDir((dir) => {
        (0, sessionModel_1.recordSessionModel)('sess-1', 'claude-opus-5-5', dir);
        strict_1.default.deepEqual((0, sessionModel_1.resolveSessionModel)('sess-1', undefined, dir), {
            model: 'claude-opus-5-5',
            source: 'sessionStart',
        });
    });
});
(0, node_test_1.test)('resolveSessionModel: a newer transcript entry wins — picks up a mid-session /model switch', () => {
    withTempDir((dir) => {
        (0, sessionModel_1.recordSessionModel)('sess-1', 'claude-opus-5-5', dir, '2026-11-03T10:00:00.000Z');
        const file = writeTranscript(dir, [assistant('claude-sonnet-5-5', '2026-11-03T10:30:00.000Z')]);
        strict_1.default.deepEqual((0, sessionModel_1.resolveSessionModel)('sess-1', file, dir), { model: 'claude-sonnet-5-5', source: 'transcript' });
    });
});
(0, node_test_1.test)('resolveSessionModel: a newer SessionStart wins over an older transcript — a resumed session', () => {
    withTempDir((dir) => {
        const file = writeTranscript(dir, [assistant('claude-sonnet-5-5', '2026-11-02T10:00:00.000Z')]);
        (0, sessionModel_1.recordSessionModel)('sess-1', 'claude-opus-5-5', dir, '2026-11-03T10:00:00.000Z');
        strict_1.default.deepEqual((0, sessionModel_1.resolveSessionModel)('sess-1', file, dir), { model: 'claude-opus-5-5', source: 'sessionStart' });
    });
});
(0, node_test_1.test)('resolveSessionModel: transcript alone works with no CLAUDE_PLUGIN_DATA', () => {
    withTempDir((dir) => {
        const file = writeTranscript(dir, [assistant('claude-opus-5-5', '2026-11-03T10:00:00.000Z')]);
        strict_1.default.deepEqual((0, sessionModel_1.resolveSessionModel)('sess-1', file, undefined), { model: 'claude-opus-5-5', source: 'transcript' });
    });
});
(0, node_test_1.test)('resolveSessionModel: nothing known resolves to no model, never a placeholder', () => {
    withTempDir((dir) => {
        strict_1.default.deepEqual((0, sessionModel_1.resolveSessionModel)('sess-1', path.join(dir, 'missing.jsonl'), dir), { source: 'none' });
    });
});
// The real entrypoints, as subprocesses — what Claude Code itself runs.
const SESSION_START = path.join(__dirname, '..', 'src', 'sessionStart.js');
const SESSION_END = path.join(__dirname, '..', 'src', 'sessionEnd.js');
function runHook(entrypoint, stdin, pluginDataDir) {
    return (0, node_child_process_1.spawnSync)(process.execPath, [entrypoint], {
        input: JSON.stringify(stdin),
        // No REVA_AUTH_TOKEN: model capture is local bookkeeping and must work
        // (and never make a network call) without any Reva config.
        env: { PATH: process.env.PATH || '', CLAUDE_PLUGIN_DATA: pluginDataDir },
        encoding: 'utf8',
        timeout: 5000,
    });
}
for (const source of ['startup', 'resume', 'clear', 'compact']) {
    (0, node_test_1.test)(`SessionStart (source=${source}) records the payload model, exits 0, no stdout`, () => {
        withTempDir((dir) => {
            const result = runHook(SESSION_START, { session_id: `s-${source}`, cwd: dir, source, model: 'claude-opus-5-5' }, dir);
            strict_1.default.equal(result.status, 0);
            strict_1.default.equal(result.stdout, '');
            strict_1.default.equal((0, sessionModel_1.loadRecordedSessionModel)(`s-${source}`, dir)?.model, 'claude-opus-5-5');
        });
    });
}
(0, node_test_1.test)('SessionStart with no model in the payload records nothing and still exits 0', () => {
    withTempDir((dir) => {
        const result = runHook(SESSION_START, { session_id: 's1', cwd: dir, source: 'startup' }, dir);
        strict_1.default.equal(result.status, 0);
        strict_1.default.equal((0, sessionModel_1.loadRecordedSessionModel)('s1', dir), undefined);
    });
});
(0, node_test_1.test)('SessionEnd removes the session’s recorded model', () => {
    withTempDir((dir) => {
        (0, sessionModel_1.recordSessionModel)('s1', 'claude-opus-5-5', dir);
        const result = runHook(SESSION_END, { session_id: 's1', cwd: dir }, dir);
        strict_1.default.equal(result.status, 0);
        strict_1.default.equal((0, sessionModel_1.loadRecordedSessionModel)('s1', dir), undefined);
    });
});
