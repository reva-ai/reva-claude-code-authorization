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
const spawnCounter_1 = require("../src/spawnCounter");
function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-spawn-'));
    try {
        fn(dir);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
(0, node_test_1.test)('first spawn in a session is index 1', () => {
    withTempDir((dir) => {
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-1', dir), 1);
    });
});
(0, node_test_1.test)('successive spawns in the same session increment', () => {
    withTempDir((dir) => {
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-1', dir), 1);
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-1', dir), 2);
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-1', dir), 3);
    });
});
(0, node_test_1.test)('different sessions have independent counters', () => {
    withTempDir((dir) => {
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-a', dir), 1);
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-a', dir), 2);
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-b', dir), 1);
    });
});
(0, node_test_1.test)('resetSpawnCounter brings the next spawn back to index 1 — a new turn is not a continuation of the last', () => {
    withTempDir((dir) => {
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-1', dir), 1);
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-1', dir), 2);
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-1', dir), 3);
        (0, spawnCounter_1.resetSpawnCounter)('sess-1', dir);
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-1', dir), 1);
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-1', dir), 2);
    });
});
(0, node_test_1.test)('resetSpawnCounter on a session that never spawned anything is a harmless no-op', () => {
    withTempDir((dir) => {
        (0, spawnCounter_1.resetSpawnCounter)('sess-never-spawned', dir);
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-never-spawned', dir), 1);
    });
});
(0, node_test_1.test)('resetSpawnCounter only affects the given session, not others', () => {
    withTempDir((dir) => {
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-a', dir), 1);
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-a', dir), 2);
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-b', dir), 1);
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-b', dir), 2);
        (0, spawnCounter_1.resetSpawnCounter)('sess-a', dir);
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-a', dir), 1);
        // sess-b is untouched by resetting sess-a
        strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-b', dir), 3);
    });
});
(0, node_test_1.test)('with no pluginDataDir, nextSpawnIndex still returns a usable value but never persists — no fallback to a home-directory dotfile', () => {
    const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
    const existedBefore = fs.existsSync(homeRevaGovernance);
    strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-1', undefined), 1);
    strict_1.default.equal((0, spawnCounter_1.nextSpawnIndex)('sess-1', undefined), 1); // still 1 — nothing to increment from
    (0, spawnCounter_1.resetSpawnCounter)('sess-1', undefined); // no-op, must not throw
    strict_1.default.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});
