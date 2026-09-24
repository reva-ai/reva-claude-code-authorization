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
const rtgCircuitBreaker_1 = require("../src/rtgCircuitBreaker");
function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-circuit-breaker-'));
    try {
        fn(dir);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
// Matches rtgCircuitBreaker.ts's own (unexported) cacheFile() convention —
// needed here only to hand-write a malformed or backdated entry.
function cacheFile(dir, sessionId) {
    return path.join(dir, 'rtg-circuit-breaker', `${sessionId}.json`);
}
(0, node_test_1.test)('a session that has never seen a 401 is closed', () => {
    withTempDir((dir) => {
        strict_1.default.equal((0, rtgCircuitBreaker_1.isCircuitOpen)('sess-1', dir).open, false);
    });
});
(0, node_test_1.test)('openCircuit latches that session, carrying status and errorType through', () => {
    withTempDir((dir) => {
        (0, rtgCircuitBreaker_1.openCircuit)('sess-1', 401, 'UNAUTHORIZED', dir);
        const status = (0, rtgCircuitBreaker_1.isCircuitOpen)('sess-1', dir);
        strict_1.default.equal(status.open, true);
        strict_1.default.equal(status.triggeredStatus, 401);
        strict_1.default.equal(status.errorType, 'UNAUTHORIZED');
        strict_1.default.ok(status.openedAt <= Date.now());
    });
});
(0, node_test_1.test)('the latch NEVER expires — openedAt is recorded but never compared to the clock', () => {
    withTempDir((dir) => {
        // Backdated a year. Under the old 4-hour window this would have reopened
        // the circuit; a session latch has no expiry at all.
        const file = cacheFile(dir, 'sess-old');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ openedAt: Date.now() - 365 * 24 * 60 * 60 * 1000, triggeredStatus: 401, errorType: 'UNAUTHORIZED' }), 'utf8');
        strict_1.default.equal((0, rtgCircuitBreaker_1.isCircuitOpen)('sess-old', dir).open, true, 'a latched session stays latched for good');
    });
});
(0, node_test_1.test)('a DIFFERENT session is unaffected — this is the recovery path', () => {
    withTempDir((dir) => {
        (0, rtgCircuitBreaker_1.openCircuit)('sess-broken', 401, 'UNAUTHORIZED', dir);
        strict_1.default.equal((0, rtgCircuitBreaker_1.isCircuitOpen)('sess-broken', dir).open, true);
        // The whole point of session scoping: the user restarts, gets a new
        // session id, and the plugin calls the RTG again immediately. Under the
        // old agent-keyed window this session would have been silenced too.
        strict_1.default.equal((0, rtgCircuitBreaker_1.isCircuitOpen)('sess-fresh', dir).open, false);
    });
});
(0, node_test_1.test)('a second 401 in the same session is idempotent', () => {
    withTempDir((dir) => {
        (0, rtgCircuitBreaker_1.openCircuit)('sess-1', 401, 'UNAUTHORIZED', dir);
        const first = (0, rtgCircuitBreaker_1.isCircuitOpen)('sess-1', dir).openedAt;
        (0, rtgCircuitBreaker_1.openCircuit)('sess-1', 401, 'UNAUTHORIZED', dir);
        const second = (0, rtgCircuitBreaker_1.isCircuitOpen)('sess-1', dir);
        strict_1.default.equal(second.open, true);
        strict_1.default.ok(second.openedAt >= first);
    });
});
(0, node_test_1.test)('an unreadable latch reads as CLOSED, so the RTG is called rather than skipped', () => {
    withTempDir((dir) => {
        const file = cacheFile(dir, 'sess-corrupt');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '{ not json', 'utf8');
        // Erring toward MAKING the governance call is the safer direction — a
        // latch we cannot read is not evidence that we should stop checking.
        strict_1.default.equal((0, rtgCircuitBreaker_1.isCircuitOpen)('sess-corrupt', dir).open, false);
    });
});
(0, node_test_1.test)('with no pluginDataDir nothing is written and nothing reads as open', () => {
    (0, rtgCircuitBreaker_1.openCircuit)('sess-1', 401, 'UNAUTHORIZED', undefined);
    strict_1.default.equal((0, rtgCircuitBreaker_1.isCircuitOpen)('sess-1', undefined).open, false);
});
(0, node_test_1.test)('an empty session id never latches', () => {
    withTempDir((dir) => {
        (0, rtgCircuitBreaker_1.openCircuit)('', 401, 'UNAUTHORIZED', dir);
        strict_1.default.equal((0, rtgCircuitBreaker_1.isCircuitOpen)('', dir).open, false);
    });
});
(0, node_test_1.test)('latches older than the 30-day stale window are swept on the next write', () => {
    withTempDir((dir) => {
        const old = cacheFile(dir, 'sess-ancient');
        fs.mkdirSync(path.dirname(old), { recursive: true });
        fs.writeFileSync(old, JSON.stringify({ openedAt: 0, triggeredStatus: 401 }), 'utf8');
        const longAgo = Date.now() - 60 * 24 * 60 * 60 * 1000;
        fs.utimesSync(old, longAgo / 1000, longAgo / 1000);
        (0, rtgCircuitBreaker_1.openCircuit)('sess-new', 401, 'UNAUTHORIZED', dir);
        strict_1.default.equal(fs.existsSync(old), false, 'stale latch removed');
        strict_1.default.equal((0, rtgCircuitBreaker_1.isCircuitOpen)('sess-new', dir).open, true, 'the new one survives');
    });
});
