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
Object.defineProperty(exports, "__esModule", { value: true });
exports.discoverMcpServers = discoverMcpServers;
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const mcpServerIdentity_1 = require("./mcpServerIdentity");
function claudeJsonPath() {
    return process.env.REVA_CLAUDE_JSON_PATH?.length ? process.env.REVA_CLAUDE_JSON_PATH : path.join(os.homedir(), '.claude.json');
}
function readJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    catch {
        return undefined;
    }
}
function toDiscovered(servers) {
    if (!servers || typeof servers !== 'object')
        return [];
    // Slugged, same as every other source — mapping.ts slugs the matching
    // token at invoke time, so the two still meet. See mcpServerIdentity.ts for
    // the collision trade-off this accepts.
    return Object.entries(servers).map(([name, entry]) => ({
        name: (0, mcpServerIdentity_1.slugifyMcpServerName)(name) || name,
        displayName: name,
        url: typeof entry?.url === 'string' ? entry.url : undefined,
    }));
}
function mcpJsonFileServers(filePath) {
    return toDiscovered(readJsonFile(filePath)?.mcpServers);
}
function projectServers(cwd) {
    return mcpJsonFileServers(path.join(cwd, '.mcp.json'));
}
// User-scope (`claude mcp add --scope user`) and local-scope (`--scope
// local`) both live inside the same ~/.claude.json — user-scope at the top
// level, local-scope nested per project path — so one read covers both.
function userAndLocalScopeServers(cwd) {
    const data = readJsonFile(claudeJsonPath());
    if (!data)
        return [];
    return [...toDiscovered(data.mcpServers), ...toDiscovered(data.projects?.[cwd]?.mcpServers)];
}
// claude.ai account connectors never appear in .mcp.json or in
// ~/.claude.json's own mcpServers/projects[cwd].mcpServers — those are only
// ever populated by `claude mcp add`. claudeAiMcpEverConnected is the one
// local record of these (see the file-level comment above for its lag).
// No url — these are account-level connectors, not something with a local
// baseUrl the way a `claude mcp add --transport http` entry has.
function claudeAiConnectorServers() {
    const names = readJsonFile(claudeJsonPath())?.claudeAiMcpEverConnected;
    if (!Array.isArray(names))
        return [];
    return names
        .filter((n) => typeof n === 'string' && n.length > 0)
        .map((name) => ({
        // "claude.ai Google Drive" -> "google-drive" — the same slug source 6
        // derives from the display name "Google Drive", so the two sources
        // de-duplicate against each other instead of double-ingesting one
        // connector under two spellings.
        name: (0, mcpServerIdentity_1.slugifyMcpServerName)(name) || name,
        displayName: name.replace(/^claude\.ai\s+/i, '') || name,
        url: undefined,
    }));
}
// Source 6 — see the file-level comment. The uuid here is the one that
// actually appears in tool names at invoke time, which is what makes this
// the source that closes the discovery/enforcement gap.
function desktopConnectorServers() {
    return (0, mcpServerIdentity_1.readDesktopConnectors)().map((connector) => ({
        name: (0, mcpServerIdentity_1.slugifyMcpServerName)(connector.name) || connector.uuid,
        displayName: connector.name,
        url: connector.url,
        uuid: connector.uuid,
    }));
}
// See the file-level comment's source #5 for what this is and why it's
// scanned globally rather than scoped to cwd, unlike userAndLocalScopeServers
// above. No url — same as a claude.ai connector: a built-in capability has
// no baseUrl of its own, still genuinely "enabled for this user."
function enabledBuiltinServers() {
    const projects = readJsonFile(claudeJsonPath())?.projects;
    if (!projects || typeof projects !== 'object')
        return [];
    const names = new Set();
    for (const project of Object.values(projects)) {
        const enabled = project?.enabledMcpServers;
        if (!Array.isArray(enabled))
            continue;
        for (const name of enabled) {
            if (typeof name === 'string' && name.length > 0)
                names.add(name);
        }
    }
    return [...names].map((name) => ({ name: (0, mcpServerIdentity_1.slugifyMcpServerName)(name) || name, displayName: name, url: undefined }));
}
// First occurrence wins on a slug collision across sources — deterministic,
// and the ORDER is now load-bearing rather than arbitrary: source 6 runs
// before source 4 because both describe the same claude.ai connectors, and
// 6's entry is strictly richer (uuid + display name + real url, vs. a bare
// prefixed name). Letting 4 win would throw away the url and silently
// downgrade a connector back to a name-only entry.
function discoverMcpServers(cwd) {
    const all = [
        ...projectServers(cwd),
        ...userAndLocalScopeServers(cwd),
        ...desktopConnectorServers(),
        ...claudeAiConnectorServers(),
        ...enabledBuiltinServers(),
    ];
    const seen = new Set();
    const result = [];
    for (const entry of all) {
        if (seen.has(entry.name))
            continue;
        seen.add(entry.name);
        result.push(entry);
    }
    return result;
}
