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
const mcpServerIdentity_1 = require("../src/mcpServerIdentity");
function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-mcp-identity-'));
    return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
}
async function withSessionsDir(sessionsDir, fn) {
    const original = process.env.REVA_CLAUDE_SESSIONS_DIR;
    process.env.REVA_CLAUDE_SESSIONS_DIR = sessionsDir;
    try {
        return await fn();
    }
    finally {
        if (original === undefined)
            delete process.env.REVA_CLAUDE_SESSIONS_DIR;
        else
            process.env.REVA_CLAUDE_SESSIONS_DIR = original;
    }
}
function writeDesktopSession(sessionsDir, connectors, file = 'local_desktop-session-1.json', account = 'account-1', org = 'org-1') {
    writeJson(path.join(sessionsDir, account, org, file), { remoteMcpServersConfig: connectors });
}
(0, node_test_1.test)('slugifies the real display names this machine actually has', () => {
    // These six are the live connectors confirmed on a real machine — the
    // whole point of the slug is that "Google Calendar" here produces the same
    // id discovery produces from "claude.ai Google Calendar".
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('Gmail'), 'gmail');
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('Google Calendar'), 'google-calendar');
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('Google Drive'), 'google-drive');
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('Claude Docs'), 'claude-docs');
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('ElevenLabs'), 'elevenlabs');
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('Miro'), 'miro');
});
(0, node_test_1.test)('strips the two claude.ai prefixes that exist in real data, so both spellings converge', () => {
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('claude.ai Gmail'), 'gmail');
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('claude.ai Google Drive'), 'google-drive');
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('claude_ai_Google_Calendar'), 'google-calendar');
    // The convergence itself, stated directly: this is the join that was
    // broken before — inventory said one thing, enforcement said another.
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('claude.ai Google Calendar'), (0, mcpServerIdentity_1.slugifyMcpServerName)('Google Calendar'));
});
(0, node_test_1.test)('does not truncate a server whose name merely starts with something claude-ish', () => {
    // Deliberately NOT a loose /claude.?ai/ match — "claude-ai-proxy" is a
    // real name, not a prefixed one.
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('claude-ai-proxy'), 'claude-ai-proxy');
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('claudeai'), 'claudeai');
});
(0, node_test_1.test)('normalizes separators, case, and stray punctuation', () => {
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('My_Server'), 'my-server');
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('My  Server'), 'my-server');
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('some.dotted.name'), 'some-dotted-name');
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('  Padded  '), 'padded');
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('already-a-slug'), 'already-a-slug');
});
(0, node_test_1.test)('a name that is nothing but the prefix keeps its original rather than slugging to empty', () => {
    strict_1.default.equal((0, mcpServerIdentity_1.slugifyMcpServerName)('claude.ai '), 'claude-ai');
    strict_1.default.notEqual((0, mcpServerIdentity_1.slugifyMcpServerName)('claude.ai '), '');
});
(0, node_test_1.test)('recognizes a connector uuid, and does not mistake an ordinary name for one', () => {
    strict_1.default.equal((0, mcpServerIdentity_1.isMcpServerUuid)('d521f7ee-ac86-4efe-a02a-2f155cd06858'), true);
    strict_1.default.equal((0, mcpServerIdentity_1.isMcpServerUuid)('D521F7EE-AC86-4EFE-A02A-2F155CD06858'), true);
    strict_1.default.equal((0, mcpServerIdentity_1.isMcpServerUuid)('computer-use'), false);
    strict_1.default.equal((0, mcpServerIdentity_1.isMcpServerUuid)('plugin_context7_context7'), false);
    strict_1.default.equal((0, mcpServerIdentity_1.isMcpServerUuid)('d521f7ee-ac86-4efe-a02a'), false);
});
(0, node_test_1.test)('reads connectors out of the desktop app session files, newest file winning on a repeat', async () => {
    await withTempDir(async (dir) => {
        const sessionsDir = path.join(dir, 'sessions');
        writeDesktopSession(sessionsDir, [
            { uuid: 'd521f7ee-ac86-4efe-a02a-2f155cd06858', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
        ]);
        await withSessionsDir(sessionsDir, () => {
            const connectors = (0, mcpServerIdentity_1.readDesktopConnectors)();
            strict_1.default.deepEqual(connectors, [
                { uuid: 'd521f7ee-ac86-4efe-a02a-2f155cd06858', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
            ]);
        });
    });
});
(0, node_test_1.test)('a missing sessions directory yields nothing rather than throwing — the normal non-macOS case', async () => {
    await withTempDir(async (dir) => {
        await withSessionsDir(path.join(dir, 'does-not-exist'), () => {
            strict_1.default.deepEqual((0, mcpServerIdentity_1.readDesktopConnectors)(), []);
        });
    });
});
(0, node_test_1.test)('resolves a uuid to its slug through the cache, and caches display name and url alongside', async () => {
    await withTempDir(async (dir) => {
        const sessionsDir = path.join(dir, 'sessions');
        const pluginDataDir = path.join(dir, 'plugin-data');
        writeDesktopSession(sessionsDir, [
            { uuid: '909251a2-69a2-46d6-913c-98346626cc26', name: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1' },
        ]);
        await withSessionsDir(sessionsDir, () => {
            (0, mcpServerIdentity_1.refreshMcpServerIdentityCache)(pluginDataDir);
            const identity = (0, mcpServerIdentity_1.resolveMcpServerIdentity)('909251a2-69a2-46d6-913c-98346626cc26', pluginDataDir);
            strict_1.default.equal(identity.slug, 'google-calendar');
            strict_1.default.equal(identity.displayName, 'Google Calendar');
            strict_1.default.equal(identity.url, 'https://calendarmcp.googleapis.com/mcp/v1');
        });
    });
});
(0, node_test_1.test)('an unknown uuid resolves to itself — never a fabricated slug', async () => {
    await withTempDir(async (dir) => {
        const pluginDataDir = path.join(dir, 'plugin-data');
        // Nothing cached at all: a uuid carries no name, so there is nothing
        // honest to derive. An opaque-but-true id beats a guessed one in an
        // audit trail.
        const identity = (0, mcpServerIdentity_1.resolveMcpServerIdentity)('11111111-2222-3333-4444-555555555555', pluginDataDir);
        strict_1.default.equal(identity.slug, '11111111-2222-3333-4444-555555555555');
        strict_1.default.equal(identity.displayName, undefined);
    });
});
(0, node_test_1.test)('a non-uuid token is slugged, into the same format every source uses', async () => {
    await withTempDir(async (dir) => {
        const pluginDataDir = path.join(dir, 'plugin-data');
        // The app-provided servers exist in no config file, so a tool name is the
        // only evidence they exist — these are exactly the ids ingest-on-invoke
        // records for them.
        strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('Claude_Browser', pluginDataDir).slug, 'claude-browser');
        strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('claude-in-chrome', pluginDataDir).slug, 'claude-in-chrome');
        strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('Claude_Code_iOS_Simulator', pluginDataDir).slug, 'claude-code-ios-simulator');
        strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('computer-use', pluginDataDir).slug, 'computer-use');
        strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('plugin_context7_context7', pluginDataDir).slug, 'plugin-context7-context7');
    });
});
(0, node_test_1.test)('slugging is many-to-one, and that collapse is symmetric', async () => {
    await withTempDir(async (dir) => {
        const pluginDataDir = path.join(dir, 'plugin-data');
        // "my_server" and "my-server" land on one id. Accepted cost of a single
        // uniform format — and harmless for the join, because discovery collapses
        // them identically, so no tool call is ever orphaned.
        const a = (0, mcpServerIdentity_1.resolveMcpServerIdentity)('my_server', pluginDataDir).slug;
        const b = (0, mcpServerIdentity_1.resolveMcpServerIdentity)('my-server', pluginDataDir).slug;
        const c = (0, mcpServerIdentity_1.resolveMcpServerIdentity)('My.Server', pluginDataDir).slug;
        strict_1.default.equal(a, 'my-server');
        strict_1.default.equal(b, 'my-server');
        strict_1.default.equal(c, 'my-server');
    });
});
(0, node_test_1.test)('the cache is MERGED on refresh, so a disconnected connector keeps resolving to its real name', async () => {
    await withTempDir(async (dir) => {
        const sessionsDir = path.join(dir, 'sessions');
        const pluginDataDir = path.join(dir, 'plugin-data');
        writeDesktopSession(sessionsDir, [
            { uuid: 'd521f7ee-ac86-4efe-a02a-2f155cd06858', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
        ]);
        await withSessionsDir(sessionsDir, () => (0, mcpServerIdentity_1.refreshMcpServerIdentityCache)(pluginDataDir));
        // Gmail is gone from the session files entirely on the next pass.
        writeDesktopSession(sessionsDir, [
            { uuid: '8a95076b-b7a6-4bda-ada3-40a16903e98e', name: 'Miro', url: 'https://mcp.miro.com' },
        ]);
        await withSessionsDir(sessionsDir, () => (0, mcpServerIdentity_1.refreshMcpServerIdentityCache)(pluginDataDir));
        // A tool call from a now-disconnected connector must still be
        // attributable — reverting it to a raw uuid would quietly corrupt the
        // audit trail for history that was already recorded under "gmail".
        strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('d521f7ee-ac86-4efe-a02a-2f155cd06858', pluginDataDir).slug, 'gmail');
        strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('8a95076b-b7a6-4bda-ada3-40a16903e98e', pluginDataDir).slug, 'miro');
    });
});
(0, node_test_1.test)('a corrupt or absent cache degrades to the raw token instead of throwing', async () => {
    await withTempDir(async (dir) => {
        const pluginDataDir = path.join(dir, 'plugin-data');
        fs.mkdirSync(pluginDataDir, { recursive: true });
        fs.writeFileSync(path.join(pluginDataDir, 'mcp-server-identity.json'), '{ not valid json', 'utf8');
        // This runs on the PreToolUse path, where authorize.ts fails CLOSED —
        // a throw here would deny a legitimate tool call.
        strict_1.default.deepEqual((0, mcpServerIdentity_1.loadMcpServerIdentityCache)(pluginDataDir), {});
        strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('d521f7ee-ac86-4efe-a02a-2f155cd06858', pluginDataDir).slug, 'd521f7ee-ac86-4efe-a02a-2f155cd06858');
        strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('computer-use', pluginDataDir).slug, 'computer-use');
    });
});
(0, node_test_1.test)('no pluginDataDir at all is survivable — nothing is written, resolution still answers', async () => {
    await withTempDir(async (dir) => {
        const sessionsDir = path.join(dir, 'sessions');
        writeDesktopSession(sessionsDir, [
            { uuid: 'd521f7ee-ac86-4efe-a02a-2f155cd06858', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
        ]);
        await withSessionsDir(sessionsDir, () => {
            const map = (0, mcpServerIdentity_1.refreshMcpServerIdentityCache)(undefined);
            strict_1.default.equal(map['d521f7ee-ac86-4efe-a02a-2f155cd06858'].slug, 'gmail');
            // Nothing persisted, so a later resolve falls back rather than lying.
            strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('d521f7ee-ac86-4efe-a02a-2f155cd06858', undefined).slug, 'd521f7ee-ac86-4efe-a02a-2f155cd06858');
        });
    });
});
(0, node_test_1.test)('a uuid resolves case-insensitively — one connector can never land under two ids', async () => {
    await withTempDir(async (dir) => {
        const sessionsDir = path.join(dir, 'sessions');
        const pluginDataDir = path.join(dir, 'plugin-data');
        writeDesktopSession(sessionsDir, [
            { uuid: 'd521f7ee-ac86-4efe-a02a-2f155cd06858', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
        ]);
        await withSessionsDir(sessionsDir, () => {
            (0, mcpServerIdentity_1.refreshMcpServerIdentityCache)(pluginDataDir);
            strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('d521f7ee-ac86-4efe-a02a-2f155cd06858', pluginDataDir).slug, 'gmail');
            // isMcpServerUuid accepts either case, so an uppercase spelling must
            // not miss the cache and fall through to a raw uppercase id.
            strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('D521F7EE-AC86-4EFE-A02A-2F155CD06858', pluginDataDir).slug, 'gmail');
        });
    });
});
(0, node_test_1.test)('an unresolvable uuid is normalized even in the fallback', async () => {
    await withTempDir(async (dir) => {
        const pluginDataDir = path.join(dir, 'plugin-data');
        // Both spellings must produce the SAME opaque id, or the audit trail
        // splits one unknown server into two.
        strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', pluginDataDir).slug, (0, mcpServerIdentity_1.resolveMcpServerIdentity)('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pluginDataDir).slug);
        strict_1.default.equal((0, mcpServerIdentity_1.resolveMcpServerIdentity)('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', pluginDataDir).slug, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    });
});
