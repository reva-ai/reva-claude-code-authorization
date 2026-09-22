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
const mcpDiscovery_1 = require("../src/mcpDiscovery");
// REVA_CLAUDE_JSON_PATH already exists as deviceId.ts's own override for
// ~/.claude.json — reused here so a test never touches the real file on the
// machine running it.
//
// REVA_CLAUDE_SESSIONS_DIR is pointed at a nonexistent path by default for
// the same reason, and it matters MORE here: source 6 reads the desktop
// app's own session files, so without this override every one of these
// tests would silently pick up whatever claude.ai connectors happen to be
// configured on the machine running the suite, and pass or fail depending
// on whose laptop it is. Tests that actually exercise source 6 pass their
// own directory.
async function withClaudeJson(claudeJsonPath, fn, sessionsDir) {
    const originalJson = process.env.REVA_CLAUDE_JSON_PATH;
    const originalSessions = process.env.REVA_CLAUDE_SESSIONS_DIR;
    process.env.REVA_CLAUDE_JSON_PATH = claudeJsonPath;
    process.env.REVA_CLAUDE_SESSIONS_DIR = sessionsDir || path.join(path.dirname(claudeJsonPath), 'no-such-sessions-dir');
    try {
        return await fn();
    }
    finally {
        if (originalJson === undefined)
            delete process.env.REVA_CLAUDE_JSON_PATH;
        else
            process.env.REVA_CLAUDE_JSON_PATH = originalJson;
        if (originalSessions === undefined)
            delete process.env.REVA_CLAUDE_SESSIONS_DIR;
        else
            process.env.REVA_CLAUDE_SESSIONS_DIR = originalSessions;
    }
}
// Writes a desktop-app session file the way the real app lays them out:
// <sessions>/<account>/<org>/local_<desktopSessionId>.json, with the
// connector list under remoteMcpServersConfig.
function writeDesktopSession(sessionsDir, connectors, account = 'account-1', org = 'org-1') {
    writeJson(path.join(sessionsDir, account, org, 'local_desktop-session-1.json'), {
        remoteMcpServersConfig: connectors,
    });
}
function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-mcp-discovery-'));
    return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
}
(0, node_test_1.test)('discovers a remote server from project .mcp.json, skips a stdio entry', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        fs.mkdirSync(cwd, { recursive: true });
        writeJson(path.join(cwd, '.mcp.json'), {
            mcpServers: {
                'remote-server': { url: 'https://example.com/mcp' },
                'stdio-server': { command: 'npx', args: ['some-mcp-server'] },
            },
        });
        await withClaudeJson(path.join(dir, 'nonexistent.json'), () => {
            const result = (0, mcpDiscovery_1.discoverMcpServers)(cwd);
            strict_1.default.deepEqual(result, [
                { name: 'remote-server', displayName: 'remote-server', url: 'https://example.com/mcp' },
                { name: 'stdio-server', displayName: 'stdio-server', url: undefined },
            ]);
        });
    });
});
(0, node_test_1.test)('a missing or malformed project .mcp.json contributes nothing, never throws', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        fs.mkdirSync(cwd, { recursive: true });
        await withClaudeJson(path.join(dir, 'nonexistent.json'), () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), []);
        });
        fs.writeFileSync(path.join(cwd, '.mcp.json'), '{ not valid json', 'utf8');
        await withClaudeJson(path.join(dir, 'nonexistent.json'), () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), []);
        });
    });
});
(0, node_test_1.test)('discovers a user-scope server from the top-level mcpServers key in ~/.claude.json', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {
            mcpServers: { 'user-scoped-server': { url: 'https://user.example.com/mcp' } },
        });
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), [
                { name: 'user-scoped-server', displayName: 'user-scoped-server', url: 'https://user.example.com/mcp' },
            ]);
        });
    });
});
(0, node_test_1.test)('discovers a local-scope server nested under projects[cwd].mcpServers, and only for the matching cwd', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project-a');
        const otherCwd = path.join(dir, 'project-b');
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {
            projects: {
                [cwd]: { mcpServers: { 'local-scoped-server': { url: 'https://local.example.com/mcp' } } },
                [otherCwd]: { mcpServers: { 'other-projects-server': { url: 'https://other.example.com/mcp' } } },
            },
        });
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), [
                { name: 'local-scoped-server', displayName: 'local-scoped-server', url: 'https://local.example.com/mcp' },
            ]);
        });
    });
});
(0, node_test_1.test)('a missing or malformed ~/.claude.json contributes nothing, never throws', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        await withClaudeJson(path.join(dir, 'nonexistent.json'), () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), []);
        });
        const claudeJson = path.join(dir, '.claude.json');
        fs.writeFileSync(claudeJson, '{ not valid json', 'utf8');
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), []);
        });
    });
});
(0, node_test_1.test)('a name present in more than one source is deduplicated — first source wins', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        fs.mkdirSync(cwd, { recursive: true });
        writeJson(path.join(cwd, '.mcp.json'), {
            mcpServers: { 'shared-name': { url: 'https://project.example.com/mcp' } },
        });
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {
            mcpServers: { 'shared-name': { url: 'https://user-scope.example.com/mcp' } },
        });
        await withClaudeJson(claudeJson, () => {
            const result = (0, mcpDiscovery_1.discoverMcpServers)(cwd);
            strict_1.default.equal(result.length, 1);
            strict_1.default.equal(result[0].url, 'https://project.example.com/mcp'); // project source wins
        });
    });
});
(0, node_test_1.test)('combines all six sources with no overlap into one flat list', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        fs.mkdirSync(cwd, { recursive: true });
        writeJson(path.join(cwd, '.mcp.json'), { mcpServers: { 'project-server': { url: 'https://project.example.com/mcp' } } });
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {
            mcpServers: { 'user-server': { url: 'https://user.example.com/mcp' } },
            projects: { [cwd]: { mcpServers: { 'local-server': { url: 'https://local.example.com/mcp' } }, enabledMcpServers: ['computer-use'] } },
            claudeAiMcpEverConnected: ['claude.ai Gmail'],
        });
        const sessionsDir = path.join(dir, 'sessions');
        writeDesktopSession(sessionsDir, [{ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Miro', url: 'https://mcp.miro.com' }]);
        await withClaudeJson(claudeJson, () => {
            const names = (0, mcpDiscovery_1.discoverMcpServers)(cwd)
                .map((s) => s.name)
                .sort();
            strict_1.default.deepEqual(names, ['computer-use', 'gmail', 'local-server', 'miro', 'project-server', 'user-server']);
        }, sessionsDir);
    });
});
(0, node_test_1.test)('discovers claude.ai account connectors from claudeAiMcpEverConnected, slugged, with no url', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {
            claudeAiMcpEverConnected: ['claude.ai Gmail', 'claude.ai Google Drive'],
        });
        await withClaudeJson(claudeJson, () => {
            // The "claude.ai " prefix is stripped and the rest slugged, so these
            // match the ids mapping.ts emits at invoke time — the whole point of
            // the slug. The original spelling survives as displayName.
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), [
                { name: 'gmail', displayName: 'Gmail', url: undefined },
                { name: 'google-drive', displayName: 'Google Drive', url: undefined },
            ]);
        });
    });
});
(0, node_test_1.test)('a missing, non-array, or non-string-entry claudeAiMcpEverConnected contributes nothing, never throws', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {});
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), []);
        });
        writeJson(claudeJson, { claudeAiMcpEverConnected: 'not-an-array' });
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), []);
        });
        writeJson(claudeJson, { claudeAiMcpEverConnected: ['claude.ai Gmail', '', 42, null] });
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), [{ name: 'gmail', displayName: 'Gmail', url: undefined }]);
        });
    });
});
(0, node_test_1.test)('a name present in both a local scope and claudeAiMcpEverConnected is deduplicated — local scope wins', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {
            mcpServers: { 'shared-name': { url: 'https://user-scope.example.com/mcp' } },
            claudeAiMcpEverConnected: ['shared-name'],
        });
        await withClaudeJson(claudeJson, () => {
            const result = (0, mcpDiscovery_1.discoverMcpServers)(cwd);
            strict_1.default.equal(result.length, 1);
            strict_1.default.equal(result[0].url, 'https://user-scope.example.com/mcp'); // user/local scope source wins
        });
    });
});
(0, node_test_1.test)('discovers an enabled built-in capability from projects[*].enabledMcpServers, with no url', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {
            projects: { '/Users/someone/Documents': { enabledMcpServers: ['computer-use'] } },
        });
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), [{ name: 'computer-use', displayName: 'computer-use', url: undefined }]);
        });
    });
});
(0, node_test_1.test)('enabledMcpServers is scanned across every project entry, not just cwd\'s — unlike local-scope mcpServers', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'this-project');
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {
            projects: {
                '/Users/someone/Documents': { enabledMcpServers: ['computer-use'] },
                [path.join(dir, 'a-totally-different-project')]: { enabledMcpServers: ['some-other-capability'] },
            },
        });
        await withClaudeJson(claudeJson, () => {
            const names = (0, mcpDiscovery_1.discoverMcpServers)(cwd)
                .map((s) => s.name)
                .sort();
            strict_1.default.deepEqual(names, ['computer-use', 'some-other-capability']);
        });
    });
});
(0, node_test_1.test)('enabledMcpServers de-duplicates the same capability enabled across multiple projects', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {
            projects: {
                '/Users/someone/Documents': { enabledMcpServers: ['computer-use'] },
                '/Users/someone/repos/other': { enabledMcpServers: ['computer-use'] },
            },
        });
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), [{ name: 'computer-use', displayName: 'computer-use', url: undefined }]);
        });
    });
});
(0, node_test_1.test)('a missing, non-object projects, or non-array/non-string-entry enabledMcpServers contributes nothing, never throws', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {});
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), []);
        });
        writeJson(claudeJson, { projects: 'not-an-object' });
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), []);
        });
        writeJson(claudeJson, { projects: { '/some/path': { enabledMcpServers: 'not-an-array' } } });
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), []);
        });
        writeJson(claudeJson, { projects: { '/some/path': { enabledMcpServers: ['computer-use', '', 42, null] } } });
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), [{ name: 'computer-use', displayName: 'computer-use', url: undefined }]);
        });
    });
});
(0, node_test_1.test)('source 6: discovers claude.ai connectors from the desktop app\'s remoteMcpServersConfig, with uuid and real url', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {});
        const sessionsDir = path.join(dir, 'sessions');
        writeDesktopSession(sessionsDir, [
            { uuid: '909251a2-69a2-46d6-913c-98346626cc26', name: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1' },
            { uuid: 'd521f7ee-ac86-4efe-a02a-2f155cd06858', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
        ]);
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), [
                {
                    name: 'google-calendar',
                    displayName: 'Google Calendar',
                    url: 'https://calendarmcp.googleapis.com/mcp/v1',
                    uuid: '909251a2-69a2-46d6-913c-98346626cc26',
                },
                {
                    name: 'gmail',
                    displayName: 'Gmail',
                    url: 'https://gmailmcp.googleapis.com/mcp/v1',
                    uuid: 'd521f7ee-ac86-4efe-a02a-2f155cd06858',
                },
            ]);
        }, sessionsDir);
    });
});
(0, node_test_1.test)('source 6 wins over claudeAiMcpEverConnected for the same connector — the richer entry is kept, not the bare name', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        const claudeJson = path.join(dir, '.claude.json');
        // Both sources describe Gmail. They slug identically, so this is a
        // genuine collision rather than a duplicate — and the ordering in
        // discoverMcpServers decides which survives.
        writeJson(claudeJson, { claudeAiMcpEverConnected: ['claude.ai Gmail'] });
        const sessionsDir = path.join(dir, 'sessions');
        writeDesktopSession(sessionsDir, [
            { uuid: 'd521f7ee-ac86-4efe-a02a-2f155cd06858', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
        ]);
        await withClaudeJson(claudeJson, () => {
            const result = (0, mcpDiscovery_1.discoverMcpServers)(cwd);
            strict_1.default.equal(result.length, 1, 'the two sources must de-duplicate, not double-ingest one connector');
            strict_1.default.equal(result[0].name, 'gmail');
            // Would be undefined if source 4 had won — that regression is the
            // whole reason the source order is deliberate.
            strict_1.default.equal(result[0].url, 'https://gmailmcp.googleapis.com/mcp/v1');
            strict_1.default.equal(result[0].uuid, 'd521f7ee-ac86-4efe-a02a-2f155cd06858');
        }, sessionsDir);
    });
});
(0, node_test_1.test)('source 6 scans every account/org, de-duplicates a connector seen in more than one session file', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {});
        const sessionsDir = path.join(dir, 'sessions');
        // Live-confirmed the same connector carries the same uuid across two
        // different accounts on one machine, so this collapses to one entry.
        writeDesktopSession(sessionsDir, [{ uuid: '1a59c906-04da-521d-bda7-7f71b9f9e01c', name: 'Claude Docs', url: 'https://api.anthropic.com/v1/pages/mcp' }], 'account-1', 'org-1');
        writeDesktopSession(sessionsDir, [
            { uuid: '1a59c906-04da-521d-bda7-7f71b9f9e01c', name: 'Claude Docs', url: 'https://api.anthropic.com/v1/pages/mcp' },
            { uuid: '8a95076b-b7a6-4bda-ada3-40a16903e98e', name: 'Miro', url: 'https://mcp.miro.com' },
        ], 'account-2', 'org-2');
        await withClaudeJson(claudeJson, () => {
            const names = (0, mcpDiscovery_1.discoverMcpServers)(cwd)
                .map((s) => s.name)
                .sort();
            strict_1.default.deepEqual(names, ['claude-docs', 'miro']);
        }, sessionsDir);
    });
});
(0, node_test_1.test)('a missing sessions dir, malformed session file, or malformed entry contributes nothing, never throws', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {});
        // Nonexistent directory — the normal case on any non-macOS host.
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), []);
        }, path.join(dir, 'no-such-dir'));
        const sessionsDir = path.join(dir, 'sessions');
        const sessionFile = path.join(sessionsDir, 'account-1', 'org-1', 'local_broken.json');
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        fs.writeFileSync(sessionFile, '{ not valid json', 'utf8');
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), []);
        }, sessionsDir);
        // Present but not an array.
        writeJson(sessionFile, { remoteMcpServersConfig: 'not-an-array' });
        await withClaudeJson(claudeJson, () => {
            strict_1.default.deepEqual((0, mcpDiscovery_1.discoverMcpServers)(cwd), []);
        }, sessionsDir);
        // Entries missing a uuid or a name are dropped; the valid one survives.
        writeJson(sessionFile, {
            remoteMcpServersConfig: [
                { name: 'No Uuid', url: 'https://example.com/mcp' },
                { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
                { uuid: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', name: 'Valid One', url: 'https://valid.example.com/mcp' },
            ],
        });
        await withClaudeJson(claudeJson, () => {
            const result = (0, mcpDiscovery_1.discoverMcpServers)(cwd);
            strict_1.default.equal(result.length, 1);
            strict_1.default.equal(result[0].name, 'valid-one');
        }, sessionsDir);
    });
});
(0, node_test_1.test)('distinct .mcp.json keys that slug alike DO collapse — the accepted cost of one uniform id format', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        fs.mkdirSync(cwd, { recursive: true });
        writeJson(path.join(cwd, '.mcp.json'), {
            mcpServers: {
                my_server: { url: 'https://a.example.com/mcp' },
                'my-server': { url: 'https://b.example.com/mcp' },
                'My.Server': { url: 'https://c.example.com/mcp' },
            },
        });
        await withClaudeJson(path.join(dir, 'nonexistent.json'), () => {
            const result = (0, mcpDiscovery_1.discoverMcpServers)(cwd);
            // Slugify is many-to-one, so these three become one id. Deliberate:
            // uniform ids everywhere were chosen over preserving every distinct
            // spelling. It is SYMMETRIC — mapping.ts collapses the same three
            // tokens onto the same id — so nothing is orphaned, first-wins.
            strict_1.default.equal(result.length, 1);
            strict_1.default.equal(result[0].name, 'my-server');
            strict_1.default.equal(result[0].displayName, 'my_server');
        });
    });
});
(0, node_test_1.test)('every source produces the same slug format', async () => {
    await withTempDir(async (dir) => {
        const cwd = path.join(dir, 'project');
        const claudeJson = path.join(dir, '.claude.json');
        writeJson(claudeJson, {
            mcpServers: { My_Local_Server: { url: 'https://local.example.com/mcp' } },
            claudeAiMcpEverConnected: ['claude.ai Google Calendar'],
            projects: { '/somewhere': { enabledMcpServers: ['computer-use'] } },
        });
        await withClaudeJson(claudeJson, () => {
            const names = (0, mcpDiscovery_1.discoverMcpServers)(cwd)
                .map((s) => s.name)
                .sort();
            // Configured key, connector display name and built-in capability all
            // come out in one format — no per-source exceptions.
            strict_1.default.deepEqual(names, ['computer-use', 'google-calendar', 'my-local-server']);
        });
    });
});
