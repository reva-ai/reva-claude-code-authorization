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
// needed here only to hand-write an already-expired or malformed entry.
function cacheFile(dir, agentId) {
    return path.join(dir, 'rtg-circuit-breaker', `${agentId}.json`);
}
(0, node_test_1.test)('no breaker has ever tripped — not disabled', () => {
    withTempDir((dir) => {
        const status = (0, rtgCircuitBreaker_1.checkCircuitBreaker)('agent-1', dir);
        strict_1.default.equal(status.disabled, false);
    });
});
(0, node_test_1.test)('tripCircuitBreaker opens the breaker for the given duration, carrying status/errorType through', () => {
    withTempDir((dir) => {
        (0, rtgCircuitBreaker_1.tripCircuitBreaker)('agent-1', 60_000, 500, 'RTG_SERVER_ERROR', dir);
        const status = (0, rtgCircuitBreaker_1.checkCircuitBreaker)('agent-1', dir);
        strict_1.default.equal(status.disabled, true);
        strict_1.default.equal(status.triggeredStatus, 500);
        strict_1.default.equal(status.errorType, 'RTG_SERVER_ERROR');
        strict_1.default.ok(status.disabledUntil > Date.now());
    });
});
(0, node_test_1.test)('a window in the past reports as not disabled', () => {
    withTempDir((dir) => {
        (0, rtgCircuitBreaker_1.tripCircuitBreaker)('agent-1', -1000, 503, 'RTG_UNAVAILABLE', dir);
        const status = (0, rtgCircuitBreaker_1.checkCircuitBreaker)('agent-1', dir);
        strict_1.default.equal(status.disabled, false);
    });
});
(0, node_test_1.test)('different agents get independent breakers', () => {
    withTempDir((dir) => {
        (0, rtgCircuitBreaker_1.tripCircuitBreaker)('agent-1', 60_000, 401, 'UNAUTHORIZED', dir);
        strict_1.default.equal((0, rtgCircuitBreaker_1.checkCircuitBreaker)('agent-1', dir).disabled, true);
        strict_1.default.equal((0, rtgCircuitBreaker_1.checkCircuitBreaker)('agent-2', dir).disabled, false);
    });
});
(0, node_test_1.test)('a later trip call replaces the previous window rather than merging with it', () => {
    withTempDir((dir) => {
        (0, rtgCircuitBreaker_1.tripCircuitBreaker)('agent-1', 60_000, 500, 'RTG_SERVER_ERROR', dir);
        (0, rtgCircuitBreaker_1.tripCircuitBreaker)('agent-1', 60_000, 424, 'RTG_FAILED_DEPENDENCY', dir);
        const status = (0, rtgCircuitBreaker_1.checkCircuitBreaker)('agent-1', dir);
        strict_1.default.equal(status.triggeredStatus, 424);
        strict_1.default.equal(status.errorType, 'RTG_FAILED_DEPENDENCY');
    });
});
(0, node_test_1.test)('malformed state file is treated as not disabled, not a crash', () => {
    withTempDir((dir) => {
        fs.mkdirSync(path.dirname(cacheFile(dir, 'agent-1')), { recursive: true });
        fs.writeFileSync(cacheFile(dir, 'agent-1'), 'not json', 'utf8');
        const status = (0, rtgCircuitBreaker_1.checkCircuitBreaker)('agent-1', dir);
        strict_1.default.equal(status.disabled, false);
    });
});
(0, node_test_1.test)('with no pluginDataDir, checkCircuitBreaker always reports not disabled and tripCircuitBreaker is a harmless no-op', () => {
    strict_1.default.equal((0, rtgCircuitBreaker_1.checkCircuitBreaker)('agent-1').disabled, false);
    strict_1.default.doesNotThrow(() => (0, rtgCircuitBreaker_1.tripCircuitBreaker)('agent-1', 60_000, 500, 'RTG_SERVER_ERROR'));
    strict_1.default.equal((0, rtgCircuitBreaker_1.checkCircuitBreaker)('agent-1').disabled, false);
});
