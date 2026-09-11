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
const hopChain_1 = require("../src/hopChain");
function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-hops-'));
    try {
        fn(dir);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
const invokeAgentHop = {
    seq: 1,
    subject: { type: 'User', id: 'alice@example.com' },
    action: { name: 'invokeAgent' },
    resource: { type: 'Agent', id: 'machine-1' },
    time: '2026-01-01T00:00:00.000Z',
};
(0, node_test_1.test)('loadAgentHops returns [] before any turn has started', () => {
    withTempDir((dir) => {
        strict_1.default.deepEqual((0, hopChain_1.loadAgentHops)('session-1', dir), []);
    });
});
(0, node_test_1.test)('startTurnHops seeds machineHops with the invokeAgent hop', () => {
    withTempDir((dir) => {
        (0, hopChain_1.startTurnHops)('session-1', invokeAgentHop, dir);
        strict_1.default.deepEqual((0, hopChain_1.loadAgentHops)('session-1', dir), [invokeAgentHop]);
    });
});
(0, node_test_1.test)('resolveSubAgentLineage returns [] when nothing is pending', () => {
    withTempDir((dir) => {
        (0, hopChain_1.startTurnHops)('session-1', invokeAgentHop, dir);
        strict_1.default.deepEqual((0, hopChain_1.resolveSubAgentLineage)('session-1', 'subagent-a', dir), []);
    });
});
(0, node_test_1.test)('a spawned subagent inherits the spawner lineage plus the spawn hop', () => {
    withTempDir((dir) => {
        (0, hopChain_1.startTurnHops)('session-1', invokeAgentHop, dir);
        const parentLineage = (0, hopChain_1.loadAgentHops)('session-1', dir);
        const spawnHop = {
            seq: 2,
            subject: { type: 'Agent', id: 'machine-1' },
            action: { name: 'spawn' },
            resource: { type: 'SubAgent', id: 'Explore' },
            time: '2026-01-01T00:00:01.000Z',
        };
        (0, hopChain_1.enqueuePendingSpawnLineage)('session-1', parentLineage, spawnHop, dir);
        const lineage = (0, hopChain_1.resolveSubAgentLineage)('session-1', 'subagent-a', dir);
        strict_1.default.deepEqual(lineage, [invokeAgentHop, spawnHop]);
    });
});
(0, node_test_1.test)('resolveSubAgentLineage is stable across repeated calls for the same subagent', () => {
    withTempDir((dir) => {
        (0, hopChain_1.startTurnHops)('session-1', invokeAgentHop, dir);
        const spawnHop = { ...invokeAgentHop, seq: 2, action: { name: 'spawn' } };
        (0, hopChain_1.enqueuePendingSpawnLineage)('session-1', [invokeAgentHop], spawnHop, dir);
        const first = (0, hopChain_1.resolveSubAgentLineage)('session-1', 'subagent-a', dir);
        const second = (0, hopChain_1.resolveSubAgentLineage)('session-1', 'subagent-a', dir);
        strict_1.default.deepEqual(first, second);
    });
});
(0, node_test_1.test)('pending spawn lineages bind to subagents in FIFO order', () => {
    withTempDir((dir) => {
        (0, hopChain_1.startTurnHops)('session-1', invokeAgentHop, dir);
        const spawnHopA = { ...invokeAgentHop, seq: 2, resource: { type: 'SubAgent', id: 'Explore' } };
        const spawnHopB = { ...invokeAgentHop, seq: 2, resource: { type: 'SubAgent', id: 'general-purpose' } };
        (0, hopChain_1.enqueuePendingSpawnLineage)('session-1', [invokeAgentHop], spawnHopA, dir);
        (0, hopChain_1.enqueuePendingSpawnLineage)('session-1', [invokeAgentHop], spawnHopB, dir);
        // First subagent tool call seen this session gets the first spawn queued.
        const lineageForFirstSeen = (0, hopChain_1.resolveSubAgentLineage)('session-1', 'subagent-a', dir);
        const lineageForSecondSeen = (0, hopChain_1.resolveSubAgentLineage)('session-1', 'subagent-b', dir);
        strict_1.default.deepEqual(lineageForFirstSeen, [invokeAgentHop, spawnHopA]);
        strict_1.default.deepEqual(lineageForSecondSeen, [invokeAgentHop, spawnHopB]);
    });
});
(0, node_test_1.test)('a nested spawn lineage is the parent subagent lineage plus its own spawn hop', () => {
    withTempDir((dir) => {
        (0, hopChain_1.startTurnHops)('session-1', invokeAgentHop, dir);
        const outerSpawnHop = { ...invokeAgentHop, seq: 2, action: { name: 'spawn' } };
        (0, hopChain_1.enqueuePendingSpawnLineage)('session-1', [invokeAgentHop], outerSpawnHop, dir);
        const outerLineage = (0, hopChain_1.resolveSubAgentLineage)('session-1', 'outer-subagent', dir);
        const innerSpawnHop = { ...invokeAgentHop, seq: 3, action: { name: 'spawn' } };
        (0, hopChain_1.enqueuePendingSpawnLineage)('session-1', outerLineage, innerSpawnHop, dir);
        const innerLineage = (0, hopChain_1.resolveSubAgentLineage)('session-1', 'inner-subagent', dir);
        strict_1.default.deepEqual(innerLineage, [invokeAgentHop, outerSpawnHop, innerSpawnHop]);
    });
});
(0, node_test_1.test)('starting a new turn clears stale pending and bound lineages from the previous turn', () => {
    withTempDir((dir) => {
        (0, hopChain_1.startTurnHops)('session-1', invokeAgentHop, dir);
        const spawnHop = { ...invokeAgentHop, seq: 2, action: { name: 'spawn' } };
        (0, hopChain_1.enqueuePendingSpawnLineage)('session-1', [invokeAgentHop], spawnHop, dir);
        (0, hopChain_1.resolveSubAgentLineage)('session-1', 'subagent-a', dir);
        const nextTurnHop = { ...invokeAgentHop, time: '2026-01-01T01:00:00.000Z' };
        (0, hopChain_1.startTurnHops)('session-1', nextTurnHop, dir);
        strict_1.default.deepEqual((0, hopChain_1.loadAgentHops)('session-1', dir), [nextTurnHop]);
        // subagent-a's binding from the previous turn is gone — nothing pending for it now.
        strict_1.default.deepEqual((0, hopChain_1.resolveSubAgentLineage)('session-1', 'subagent-a', dir), []);
    });
});
(0, node_test_1.test)('different sessions have independent hop chains', () => {
    withTempDir((dir) => {
        (0, hopChain_1.startTurnHops)('session-1', invokeAgentHop, dir);
        strict_1.default.deepEqual((0, hopChain_1.loadAgentHops)('session-2', dir), []);
    });
});
(0, node_test_1.test)('with no pluginDataDir, everything no-ops instead of falling back to a home-directory dotfile', () => {
    const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
    const existedBefore = fs.existsSync(homeRevaGovernance);
    (0, hopChain_1.startTurnHops)('session-1', invokeAgentHop, undefined);
    strict_1.default.deepEqual((0, hopChain_1.loadAgentHops)('session-1', undefined), []); // never actually persisted
    strict_1.default.deepEqual((0, hopChain_1.resolveSubAgentLineage)('session-1', 'subagent-a', undefined), []);
    strict_1.default.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});
