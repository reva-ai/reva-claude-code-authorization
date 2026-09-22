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
const debug_1 = require("../src/debug");
function withEnv(vars, fn) {
    const original = {};
    for (const key of Object.keys(vars)) {
        original[key] = process.env[key];
        if (vars[key] === undefined)
            delete process.env[key];
        else
            process.env[key] = vars[key];
    }
    try {
        return fn();
    }
    finally {
        for (const key of Object.keys(original)) {
            if (original[key] === undefined)
                delete process.env[key];
            else
                process.env[key] = original[key];
        }
    }
}
function captureStderr(fn) {
    const written = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
        written.push(String(chunk));
        return true;
    };
    try {
        return { result: fn(), written };
    }
    finally {
        process.stderr.write = original;
    }
}
function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-debug-'));
    try {
        fn(dir);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
(0, node_test_1.test)('debugLog writes nothing at all when REVA_DEBUG is unset', () => {
    withTempDir((dir) => {
        withEnv({ REVA_DEBUG: undefined, CLAUDE_PLUGIN_DATA: dir }, () => {
            const { written } = captureStderr(() => (0, debug_1.debugLog)('should not appear'));
            strict_1.default.deepEqual(written, []);
            strict_1.default.equal(fs.existsSync(path.join(dir, 'debug.log')), false);
        });
    });
});
(0, node_test_1.test)('debugLog writes to stderr, unprefixed by timestamp, when REVA_DEBUG is set', () => {
    withEnv({ REVA_DEBUG: '1', CLAUDE_PLUGIN_DATA: undefined }, () => {
        const { written } = captureStderr(() => (0, debug_1.debugLog)('hello'));
        strict_1.default.deepEqual(written, ['[reva-security] hello\n']);
    });
});
(0, node_test_1.test)('debugLog also appends a timestamped line to CLAUDE_PLUGIN_DATA/debug.log when both are set', () => {
    withTempDir((dir) => {
        withEnv({ REVA_DEBUG: '1', CLAUDE_PLUGIN_DATA: dir }, () => {
            captureStderr(() => (0, debug_1.debugLog)('hello'));
        });
        const content = fs.readFileSync(path.join(dir, 'debug.log'), 'utf8');
        strict_1.default.match(content, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] hello\n$/);
    });
});
(0, node_test_1.test)('debugLog appends across multiple calls rather than overwriting', () => {
    withTempDir((dir) => {
        withEnv({ REVA_DEBUG: '1', CLAUDE_PLUGIN_DATA: dir }, () => {
            captureStderr(() => {
                (0, debug_1.debugLog)('first');
                (0, debug_1.debugLog)('second');
            });
        });
        const content = fs.readFileSync(path.join(dir, 'debug.log'), 'utf8');
        const lines = content.trim().split('\n');
        strict_1.default.equal(lines.length, 2);
        strict_1.default.match(lines[0], /first$/);
        strict_1.default.match(lines[1], /second$/);
    });
});
(0, node_test_1.test)('debugLog with REVA_DEBUG set but no CLAUDE_PLUGIN_DATA: stderr only, no file, no throw', () => {
    withEnv({ REVA_DEBUG: '1', CLAUDE_PLUGIN_DATA: undefined }, () => {
        const { written } = captureStderr(() => (0, debug_1.debugLog)('no plugin data dir'));
        strict_1.default.deepEqual(written, ['[reva-security] no plugin data dir\n']);
    });
});
(0, node_test_1.test)('debugLog never throws even when CLAUDE_PLUGIN_DATA points somewhere unwritable', () => {
    withEnv({ REVA_DEBUG: '1', CLAUDE_PLUGIN_DATA: '/nonexistent-root/reva-governance-debug-test' }, () => {
        strict_1.default.doesNotThrow(() => captureStderr(() => (0, debug_1.debugLog)('should not throw')));
    });
});
