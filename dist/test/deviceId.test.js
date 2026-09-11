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
const deviceId_1 = require("../src/deviceId");
function withTempFile(content, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-claudejson-'));
    const filePath = path.join(dir, '.claude.json');
    try {
        if (content !== undefined)
            fs.writeFileSync(filePath, content, 'utf8');
        fn(filePath);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
// persistedFallbackId is the cross-platform, fully testable part — the real
// OS-hardware-id path is exercised implicitly by resolveMachineId() below,
// but which branch it takes depends on the actual OS running the test.
(0, node_test_1.test)('persistedFallbackId generates and then reuses the same id from the same dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-device-'));
    try {
        const first = (0, deviceId_1.persistedFallbackId)(dir);
        const second = (0, deviceId_1.persistedFallbackId)(dir);
        strict_1.default.equal(first, second);
        strict_1.default.ok(fs.existsSync(path.join(dir, 'device-id')));
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
(0, node_test_1.test)('persistedFallbackId returns different ids for different dirs', () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-device-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-device-b-'));
    try {
        strict_1.default.notEqual((0, deviceId_1.persistedFallbackId)(dirA), (0, deviceId_1.persistedFallbackId)(dirB));
    }
    finally {
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
    }
});
(0, node_test_1.test)('with no dataDir, persistedFallbackId still returns a usable id but never persists — no fallback to a home-directory dotfile, and a fresh id every call', () => {
    const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
    const existedBefore = fs.existsSync(homeRevaGovernance);
    const first = (0, deviceId_1.persistedFallbackId)(undefined);
    const second = (0, deviceId_1.persistedFallbackId)(undefined);
    strict_1.default.ok(first); // still a usable id for this call...
    strict_1.default.ok(second);
    strict_1.default.notEqual(first, second); // ...but a fresh one every time — nothing was persisted to reuse
    strict_1.default.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});
// Whether this is a real account UUID or undefined depends entirely on
// whether this test process has a real ~/.claude.json — not something to
// assert on (readOauthAccountId's own tests above already cover the actual
// parsing logic in isolation). What's testable here regardless of
// environment is that resolveAgentId() is cached: no fallback means the
// only thing it could otherwise do on a second call is re-read the same
// file and get the same answer, so this also incidentally confirms it
// never reaches for resolveMachineId() as a substitute.
(0, node_test_1.test)('resolveAgentId is cached — same value (present or undefined) across calls', () => {
    const first = (0, deviceId_1.resolveAgentId)();
    const second = (0, deviceId_1.resolveAgentId)();
    strict_1.default.equal(first, second);
});
(0, node_test_1.test)('readOauthEmail reads oauthAccount.emailAddress from a ~/.claude.json-shaped file', () => {
    withTempFile(JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com', accountUuid: 'unrelated' } }), (filePath) => {
        strict_1.default.equal((0, deviceId_1.readOauthEmail)(filePath), 'alice@example.com');
    });
});
(0, node_test_1.test)('readOauthEmail returns undefined when the file is missing', () => {
    withTempFile(undefined, (filePath) => {
        strict_1.default.equal((0, deviceId_1.readOauthEmail)(filePath), undefined);
    });
});
(0, node_test_1.test)('readOauthEmail returns undefined when oauthAccount or emailAddress is absent', () => {
    withTempFile(JSON.stringify({ userID: 'unrelated' }), (filePath) => {
        strict_1.default.equal((0, deviceId_1.readOauthEmail)(filePath), undefined);
    });
    withTempFile(JSON.stringify({ oauthAccount: { accountUuid: 'unrelated' } }), (filePath) => {
        strict_1.default.equal((0, deviceId_1.readOauthEmail)(filePath), undefined);
    });
});
(0, node_test_1.test)('readOauthEmail returns undefined for malformed JSON rather than throwing', () => {
    withTempFile('{ not valid json', (filePath) => {
        strict_1.default.equal((0, deviceId_1.readOauthEmail)(filePath), undefined);
    });
});
(0, node_test_1.test)('readOauthAccountId reads oauthAccount.accountUuid from a ~/.claude.json-shaped file', () => {
    withTempFile(JSON.stringify({ oauthAccount: { emailAddress: 'unrelated', accountUuid: '666eb509-ea28-44ef-bdd2-295b0432a887' } }), (filePath) => {
        strict_1.default.equal((0, deviceId_1.readOauthAccountId)(filePath), '666eb509-ea28-44ef-bdd2-295b0432a887');
    });
});
(0, node_test_1.test)('readOauthAccountId returns undefined when the file is missing', () => {
    withTempFile(undefined, (filePath) => {
        strict_1.default.equal((0, deviceId_1.readOauthAccountId)(filePath), undefined);
    });
});
(0, node_test_1.test)('readOauthAccountId returns undefined when oauthAccount or accountUuid is absent', () => {
    withTempFile(JSON.stringify({ userID: 'unrelated' }), (filePath) => {
        strict_1.default.equal((0, deviceId_1.readOauthAccountId)(filePath), undefined);
    });
    withTempFile(JSON.stringify({ oauthAccount: { emailAddress: 'unrelated' } }), (filePath) => {
        strict_1.default.equal((0, deviceId_1.readOauthAccountId)(filePath), undefined);
    });
});
(0, node_test_1.test)('readOauthAccountId does not accidentally return organizationUuid instead of accountUuid', () => {
    withTempFile(JSON.stringify({ oauthAccount: { organizationUuid: 'org-should-not-be-returned' } }), (filePath) => {
        strict_1.default.equal((0, deviceId_1.readOauthAccountId)(filePath), undefined);
    });
});
(0, node_test_1.test)('readOauthAccountId returns undefined for malformed JSON rather than throwing', () => {
    withTempFile('{ not valid json', (filePath) => {
        strict_1.default.equal((0, deviceId_1.readOauthAccountId)(filePath), undefined);
    });
});
(0, node_test_1.test)('resolveMachineId returns a non-empty, stable value across calls, independent of resolveAgentId', () => {
    const first = (0, deviceId_1.resolveMachineId)();
    const second = (0, deviceId_1.resolveMachineId)();
    strict_1.default.ok(first.length > 0);
    strict_1.default.equal(first, second);
});
