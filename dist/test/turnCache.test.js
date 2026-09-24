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
const turnCache_1 = require("../src/turnCache");
function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-turn-'));
    try {
        fn(dir);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
(0, node_test_1.test)('startTurn persists a span id that loadTurn reads back for the same session', () => {
    withTempDir((dir) => {
        const turn = (0, turnCache_1.startTurn)('sess-1', 'do the thing', dir);
        const loaded = (0, turnCache_1.loadTurn)('sess-1', dir);
        strict_1.default.equal(loaded?.traceId, turn.traceId);
        strict_1.default.equal(loaded?.prompt, 'do the thing');
        strict_1.default.equal(loaded?.turn, 1);
        strict_1.default.match(loaded?.startedAt || '', /^\d{4}-\d{2}-\d{2}T/);
    });
});
(0, node_test_1.test)('a second startTurn call for the same session overwrites the previous turn', () => {
    withTempDir((dir) => {
        const first = (0, turnCache_1.startTurn)('sess-1', 'turn one prompt', dir);
        const second = (0, turnCache_1.startTurn)('sess-1', 'turn two prompt', dir);
        strict_1.default.notEqual(first.traceId, second.traceId);
        const loaded = (0, turnCache_1.loadTurn)('sess-1', dir);
        strict_1.default.equal(loaded?.traceId, second.traceId);
        strict_1.default.equal(loaded?.prompt, 'turn two prompt');
        strict_1.default.equal(loaded?.turn, 2);
        strict_1.default.equal(second.startedAt, first.startedAt);
    });
});
(0, node_test_1.test)('different sessions get independent turn entries', () => {
    withTempDir((dir) => {
        const a = (0, turnCache_1.startTurn)('sess-a', 'prompt a', dir);
        const b = (0, turnCache_1.startTurn)('sess-b', 'prompt b', dir);
        strict_1.default.notEqual(a.traceId, b.traceId);
        strict_1.default.equal((0, turnCache_1.loadTurn)('sess-a', dir)?.traceId, a.traceId);
        strict_1.default.equal((0, turnCache_1.loadTurn)('sess-b', dir)?.traceId, b.traceId);
    });
});
(0, node_test_1.test)('loadTurn returns undefined for a session that never started a turn', () => {
    withTempDir((dir) => {
        strict_1.default.equal((0, turnCache_1.loadTurn)('never-seen', dir), undefined);
    });
});
(0, node_test_1.test)('a prompt-less turn still gets a span id, with no prompt field', () => {
    withTempDir((dir) => {
        const turn = (0, turnCache_1.startTurn)('sess-1', undefined, dir);
        const loaded = (0, turnCache_1.loadTurn)('sess-1', dir);
        strict_1.default.equal(loaded?.traceId, turn.traceId);
        strict_1.default.equal(loaded?.prompt, undefined);
    });
});
(0, node_test_1.test)('direct session is metadata-only and conversation uses the observed prompt timestamp', () => {
    withTempDir((dir) => {
        const turn = (0, turnCache_1.startTurn)('sess-1', 'do the thing', dir);
        strict_1.default.deepEqual((0, turnCache_1.directSessionFromTurn)('sess-1', turn), {
            id: 'sess-1',
            turn: 1,
            startedAt: turn.startedAt,
        });
        strict_1.default.equal('messages' in (0, turnCache_1.directSessionFromTurn)('sess-1', turn), false);
        strict_1.default.deepEqual((0, turnCache_1.conversationFromTurn)(turn), [
            {
                seq: 1,
                role: 'user',
                contentType: 'text/plain',
                content: 'do the thing',
                timestamp: turn.promptTimestamp,
            },
        ]);
    });
});
(0, node_test_1.test)('truncatePrompt caps very long prompts', () => {
    const long = 'x'.repeat(3000);
    const truncated = (0, turnCache_1.truncatePrompt)(long);
    strict_1.default.ok(truncated.length < long.length);
    strict_1.default.ok(truncated.endsWith('…'));
});
(0, node_test_1.test)('truncatePrompt leaves short prompts untouched', () => {
    strict_1.default.equal((0, turnCache_1.truncatePrompt)('short prompt'), 'short prompt');
});
(0, node_test_1.test)('with no pluginDataDir, startTurn/loadTurn still work but never persist — no fallback to a home-directory dotfile', () => {
    const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
    const existedBefore = fs.existsSync(homeRevaGovernance);
    const turn = (0, turnCache_1.startTurn)('sess-1', 'hello', undefined);
    strict_1.default.equal(turn.turn, 1); // still a usable entry for this call
    strict_1.default.equal((0, turnCache_1.loadTurn)('sess-1', undefined), undefined); // but never actually persisted
    strict_1.default.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});
(0, node_test_1.test)('with no pluginDataDir the trace id is derived, so separate hooks still share a turn', () => {
    // A minted id can only be shared if it can be persisted — every later hook
    // in the turn is its own process and reads it back from the cache. Without
    // a cache to write to, minting would give each process a different random
    // id and the turn would fragment into one trace per RTG call.
    const a = (0, turnCache_1.resolveTurnTraceId)('sess-nodir', (0, turnCache_1.loadOrStartTurn)('sess-nodir', undefined));
    const b = (0, turnCache_1.resolveTurnTraceId)('sess-nodir', (0, turnCache_1.loadOrStartTurn)('sess-nodir', undefined));
    strict_1.default.equal(a, b, 'separate processes must agree with no cache available');
    strict_1.default.match(a, /^[0-9a-f]{32}$/);
});
(0, node_test_1.test)('an upgrade from a pre-traceId cache entry keeps the turn and derives a shared trace', () => {
    withTempDir((dir) => {
        // Exactly the shape written before traceId existed: spanId, no traceId.
        fs.mkdirSync(path.join(dir, 'turns'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'turns', 'sess-old.json'), JSON.stringify({
            spanId: 'c515b2193e5f1234',
            promptTimestamp: '2026-09-20T10:00:00.000Z',
            turn: 13,
            startedAt: '2026-09-20T09:00:00.000Z',
            prompt: 'an older prompt',
        }), 'utf8');
        const turn = (0, turnCache_1.loadOrStartTurn)('sess-old', dir);
        // The turn must be REUSED, not restarted — restarting would bump the
        // counter and lose the conversation's own history.
        strict_1.default.equal(turn.turn, 13);
        strict_1.default.equal(turn.startedAt, '2026-09-20T09:00:00.000Z');
        strict_1.default.equal(turn.traceId, undefined);
        // …and every hook still agrees on a trace for it, via the fallback.
        const first = (0, turnCache_1.resolveTurnTraceId)('sess-old', turn);
        const second = (0, turnCache_1.resolveTurnTraceId)('sess-old', (0, turnCache_1.loadOrStartTurn)('sess-old', dir));
        strict_1.default.equal(first, second);
        strict_1.default.match(first, /^[0-9a-f]{32}$/);
        // The next prompt recovers to a minted id and drops the stale field.
        const next = (0, turnCache_1.startTurn)('sess-old', 'next prompt', dir);
        strict_1.default.match(next.traceId || '', /^[0-9a-f]{32}$/);
        strict_1.default.equal(next.turn, 14);
        strict_1.default.equal(next.startedAt, '2026-09-20T09:00:00.000Z');
        strict_1.default.ok(!('spanId' in next));
    });
});
