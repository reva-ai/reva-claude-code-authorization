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
const identity_1 = require("../src/identity");
function withClaudeJson(content, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-identity-'));
    const filePath = path.join(dir, '.claude.json');
    const previous = process.env.REVA_CLAUDE_JSON_PATH;
    try {
        if (content !== undefined)
            fs.writeFileSync(filePath, content, 'utf8');
        process.env.REVA_CLAUDE_JSON_PATH = filePath;
        fn(filePath);
    }
    finally {
        if (previous === undefined)
            delete process.env.REVA_CLAUDE_JSON_PATH;
        else
            process.env.REVA_CLAUDE_JSON_PATH = previous;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
(0, node_test_1.test)('resolveUserEmail reads oauthAccount.emailAddress from ~/.claude.json', () => {
    withClaudeJson(JSON.stringify({ oauthAccount: { emailAddress: 'oauth@example.com' } }), () => {
        strict_1.default.equal((0, identity_1.resolveUserEmail)(), 'oauth@example.com');
    });
});
(0, node_test_1.test)('resolveUserEmail falls back to OS username when oauth email is absent', () => {
    withClaudeJson('{}', () => {
        strict_1.default.equal((0, identity_1.resolveUserEmail)(), os.userInfo().username);
    });
});
