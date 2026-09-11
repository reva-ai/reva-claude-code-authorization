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
exports.AGENT_TYPE = void 0;
exports.resolveEntityTypeIds = resolveEntityTypeIds;
exports.ingestUser = ingestUser;
exports.ingestAgent = ingestAgent;
exports.ingestMcpServersFromConfig = ingestMcpServersFromConfig;
exports.parseMcpListOutput = parseMcpListOutput;
exports.pollMcpServers = pollMcpServers;
const node_child_process_1 = require("node:child_process");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const debug_1 = require("./debug");
// No fallback: only ever writes inside CLAUDE_PLUGIN_DATA (Claude Code's
// own per-plugin data directory — the officially documented mechanism for
// exactly this). Without it, there is nothing honest to write to — every
// change-signature check just always reports "changed," so ingestion is
// simply attempted fresh on every session rather than caching anything.
function cacheDir(pluginDataDir) {
    return pluginDataDir ? path.join(pluginDataDir, 'entity-types') : undefined;
}
// Shared across every concurrently-open Claude Code session on the machine.
// Worst case on a cold-cache race between two sessions is a harmless
// duplicate GET/POST, not corruption.
function cacheFile(pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    return dir ? path.join(dir, 'catalog.json') : undefined;
}
function loadIngestionCache(pluginDataDir) {
    const file = cacheFile(pluginDataDir);
    if (!file)
        return undefined;
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
function saveIngestionCache(entry, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    const file = cacheFile(pluginDataDir);
    if (!dir || !file)
        return;
    try {
        fs.mkdirSync(dir, { recursive: true });
        // Merge onto whatever's already cached (entity-type ids and ingested
        // signatures are written independently, at different points in
        // sessionStart.ts's flow) rather than clobbering one with the other.
        const existing = loadIngestionCache(pluginDataDir) || {};
        fs.writeFileSync(file, JSON.stringify({ ...existing, ...entry }), 'utf8');
    }
    catch {
        // best effort — a fetch/ingest just happens again next session
    }
}
async function ingestionFetch(cfg, url, method, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.ingestionTimeoutMs);
    try {
        const res = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(cfg.authorization ? { 'X-API-Token': cfg.authorization } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`ingestion API returned HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        return await res.json().catch(() => undefined);
    }
    finally {
        clearTimeout(timer);
    }
}
async function fetchEntityTypes(cfg) {
    const url = `${cfg.ingestionUrl}/policy-store/entity-types`;
    const raw = await ingestionFetch(cfg, url, 'GET');
    return Array.isArray(raw) ? raw : [];
}
// Resolves the entity-type ids ingestion calls need to pass as
// `entityTypeId`, caching them so a normal session start doesn't cost a
// network round-trip once they're known. Falls back to whatever was already
// cached if a fresh fetch fails.
async function resolveEntityTypeIds(cfg, pluginDataDir) {
    const cached = loadIngestionCache(pluginDataDir);
    // All three must be resolved for the cache to count as fresh — a partial
    // result (e.g. MCPServer missing because it wasn't yet in the catalog on
    // an earlier fetch) keeps retrying on future sessions instead of getting
    // stuck on the same gap forever. The accepted cost: a catalog that
    // genuinely never offers an MCPServer entity type re-fetches on every
    // session rather than caching that absence — one extra lightweight GET,
    // already bounded by ingestionTimeoutMs, not worth more cache complexity
    // to optimize away.
    if (cached?.userEntityTypeId && cached?.agentEntityTypeId && cached?.mcpServerEntityTypeId) {
        return cached;
    }
    try {
        const types = await fetchEntityTypes(cfg);
        // Matched by name alone — confirmed live there's exactly one entity
        // type per name in this catalog (no cross-schema duplicates), so
        // an earlier schemaName filter was unnecessary complexity. Warn (not
        // fail) if that assumption is ever violated, so a silent misresolution
        // at least leaves a trace under REVA_DEBUG=1.
        for (const name of ['User', 'Agent', 'MCPServer']) {
            const matches = types.filter((t) => t.name === name);
            if (matches.length > 1) {
                (0, debug_1.debugLog)(`resolveEntityTypeIds: multiple entity types named "${name}" — using the first (id=${matches[0].id})`);
            }
        }
        const entry = {
            userEntityTypeId: types.find((t) => t.name === 'User')?.id,
            agentEntityTypeId: types.find((t) => t.name === 'Agent')?.id,
            mcpServerEntityTypeId: types.find((t) => t.name === 'MCPServer')?.id,
        };
        saveIngestionCache(entry, pluginDataDir);
        return entry;
    }
    catch {
        return cached || {};
    }
}
async function postEntity(cfg, entityTypeId, entityId, attributes) {
    const url = `${cfg.ingestionUrl}/entity?entityTypeId=${encodeURIComponent(entityTypeId)}`;
    await ingestionFetch(cfg, url, 'POST', { entityId, attributes, parents: [], children: [] });
}
// Confirmed shape: PATCH /entity/{entityId}?entityTypeId={id}, body
// {attributeValue: {name, value}, op: "ADD", path: "ATTRIBUTE"}. The
// confirmed, load-bearing use is User.registeredMachineIds — a genuine Set
// (one User can log in from multiple machines), where a plain overwrite
// would let whichever call lands last clobber what an earlier one already
// recorded, so ADD accumulates instead. Also used to update an existing
// Agent's agentType (see ingestAgent() below) — that one is scalar, not a
// Set, but this ADD-op PATCH is the only confirmed way to write an
// attribute onto an already-existing entity, so it's reused as-is rather
// than guessing at an unconfirmed "overwrite" shape.
async function addAttributeValue(cfg, entityTypeId, entityId, attribute) {
    const url = `${cfg.ingestionUrl}/entity/${encodeURIComponent(entityId)}?entityTypeId=${encodeURIComponent(entityTypeId)}`;
    await ingestionFetch(cfg, url, 'PATCH', { attributeValue: attribute, op: 'ADD', path: 'ATTRIBUTE' });
}
// Confirmed shape:
//   GET {ingestionUrl}/entity/{entityId}?entityTypeId={id}
//   200 -> a full entity record (id/entityAttributes/createdOn/...) — exists
//   404 or 400 -> not found (some backends return 400 rather than a clean
//                 404 for an unresolvable entityId on this lookup)
// Nothing in the 200 body is otherwise inspected — this only answers "does
// this entity already exist," which ingestUser()/ingestAgent() both use to
// decide whether to POST a new one. Generic over entity type/id — the
// mechanics are identical for User and Agent, only which
// entityTypeId/entityId gets passed differs. Any status/error other than a
// clean 200/404/400 is a genuine failure, not a decision either way —
// thrown, not swallowed here, so the caller can choose how to treat
// "inconclusive".
async function entityExists(cfg, entityTypeId, entityId) {
    const url = `${cfg.ingestionUrl}/entity/${encodeURIComponent(entityId)}?entityTypeId=${encodeURIComponent(entityTypeId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.ingestionTimeoutMs);
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                ...(cfg.authorization ? { 'X-API-Token': cfg.authorization } : {}),
            },
            signal: controller.signal,
        });
        // 404 is the obvious "not found." 400 is also treated as not-found —
        // some backends return it for an unresolvable entityId on this v1
        // lookup rather than a clean 404, and there's nothing else a 400 on a
        // plain GET-by-id could mean here (no request body to be malformed).
        if (res.status === 404 || res.status === 400)
            return false;
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`ingestion GET entity returned HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        return true;
    }
    finally {
        clearTimeout(timer);
    }
}
// "ClaudeCode" is a constant, not detected — this plugin only ever runs
// inside Claude Code, loaded exclusively through Claude Code's own hook/
// plugin system, so there's no real signal to detect "actually running
// under Kiro/Codex/Cursor" from inside this codebase: those tools can't
// load this plugin in the first place. Other Reva integrations (e.g.
// reva-cowork-plugin's Kiro/Codex support) set their own value for their
// own Agent. Exported since context.ts also sends this as context.agentType
// on every evaluation request, not just ingestion's Agent.agentType.
exports.AGENT_TYPE = 'ClaudeCode';
// GET-then-branch, every session: entityExists() (GET, above) decides
// whether to POST a new User at all — never re-created if one's already
// there. Not found: a single POST creates the User with `active`,
// registeredMachineIds, AND agents already set — no follow-up PATCH
// needed, since there's nothing to accumulate onto yet on a brand-new
// entity. Found: no POST (never re-created), just two PATCH-ADDs — one for
// registeredMachineIds, one for agents — each on its own, since this
// existing User's Sets may already hold values (a different machine, a
// different account) that must be kept, not overwritten (see
// addAttributeValue). Two separate PATCH calls, not one, because the
// confirmed wire shape carries exactly one attributeValue per PATCH — there
// is no confirmed way to ADD to two different Set attributes in one call.
// Logging in from the same machine/account twice is a harmless repeat ADD
// either way (Set semantics).
//
// agents links this User back to every Agent (account id) it's associated
// with — a Set, deliberately, since one human could in principle be linked
// to more than one Anthropic account over time (a re-auth, a second
// account); value is always cfg.agentId, the same id ingestAgent() below
// uses as the Agent entity's own id.
//
// `active` is only ever sent once, in that creation POST, as "false" —
// this plugin has no basis to vouch for the human behind userEmail, and
// never touches `active` again once a User is found to already exist. A
// human/admin verification flow on the Reva side, not this plugin, is
// what's expected to flip active to true.
//
// On an inconclusive existence check (anything other than a clean
// found/not-found — network error, 5xx, timeout), this deliberately does
// NOT guess "not found": erring toward "assume it might already exist,
// don't risk a duplicate/conflicting create" is safer than a wrong POST,
// and the whole check just runs again next session once the underlying
// problem clears. That means an inconclusive check takes the same
// PATCH-only path as "found" — if the User genuinely doesn't exist yet,
// those PATCHes fail harmlessly (logged, not fatal) and the whole thing
// retries next session same as the rest of this file's best-effort calls.
async function ingestUser(cfg, userEntityTypeId, userEmail, machineId, agentId) {
    const exists = await entityExists(cfg, userEntityTypeId, userEmail).catch((err) => {
        (0, debug_1.debugLog)(`ingestUser: existence check failed (assuming exists, skipping create) — ${err}`);
        return true;
    });
    if (!exists) {
        await postEntity(cfg, userEntityTypeId, userEmail, [
            { name: 'active', value: 'false' },
            { name: 'registeredMachineIds', value: machineId },
            { name: 'agents', value: agentId },
        ]).catch((err) => (0, debug_1.debugLog)(`ingestUser: POST failed — ${err}`));
    }
    else {
        await addAttributeValue(cfg, userEntityTypeId, userEmail, { name: 'registeredMachineIds', value: machineId }).catch((err) => (0, debug_1.debugLog)(`ingestUser: PATCH registeredMachineIds failed — ${err}`));
        await addAttributeValue(cfg, userEntityTypeId, userEmail, { name: 'agents', value: agentId }).catch((err) => (0, debug_1.debugLog)(`ingestUser: PATCH agents failed — ${err}`));
    }
}
// Same GET-then-branch pattern as ingestUser() above, restructured the same
// way: entityExists() (GET) decides whether to POST a new Agent at all —
// never re-created (with a fresh, possibly-stale `user` attribute) if one's
// already there for this account. Not found: a single POST creates the
// Agent with both `user` and agentType already set — no follow-up PATCH
// needed. Found: no POST, just an update of agentType on its own, via the
// same ADD-op PATCH addAttributeValue() also uses for genuine Sets (see its
// own comment) — the only confirmed write-an-attribute shape available.
//
// agentType is a scalar now, not a Set — Agent's id is the Anthropic
// account id (see deviceId.ts's resolveAgentId), and from this plugin's own
// perspective that account is always talking to Reva through exactly one
// tool, this one, so there's nothing to accumulate: agentType is always
// AGENT_TYPE ("ClaudeCode"), full stop. (A Set was the original design
// because the same account could in principle also be seen through a
// different Reva integration — e.g. reva-cowork-plugin's Kiro/Codex support
// — but that's a different plugin's ingestion call with its own value, not
// something this file needs to account for in its own attribute shape.)
//
// userEmail here is only ever sent as an ATTRIBUTE VALUE on the Agent
// entity (a reference back to which human this account belongs to) — this
// never creates, updates, or otherwise writes to the User entity itself
// (ingestUser() above does, separately).
//
// Same inconclusive-check handling as ingestUser(): anything other than a
// clean found/not-found (network error, 5xx, timeout) assumes "exists,"
// taking the same PATCH-only path as a genuine "found" rather than risking
// a wrong POST — the whole check just runs again next session. If the
// Agent genuinely doesn't exist yet, that PATCH fails harmlessly (logged,
// not fatal) and retries next session same as the rest of this file's
// best-effort calls.
async function ingestAgent(cfg, agentEntityTypeId, agentId, userEmail) {
    const exists = await entityExists(cfg, agentEntityTypeId, agentId).catch((err) => {
        (0, debug_1.debugLog)(`ingestAgent: existence check failed (assuming exists, skipping create) — ${err}`);
        return true;
    });
    if (!exists) {
        await postEntity(cfg, agentEntityTypeId, agentId, [
            { name: 'user', value: userEmail },
            { name: 'agentType', value: exports.AGENT_TYPE },
        ]).catch((err) => (0, debug_1.debugLog)(`ingestAgent: POST failed — ${err}`));
    }
    else {
        await addAttributeValue(cfg, agentEntityTypeId, agentId, { name: 'agentType', value: exports.AGENT_TYPE }).catch((err) => (0, debug_1.debugLog)(`ingestAgent: PATCH agentType failed — ${err}`));
    }
}
// Best-effort, partial: `.mcp.json` only ever gives a server *name* plus
// either a `url` (remote/http) or `command`/`args` (stdio, no URL at all).
// MCPServer's schema requires `baseUrl`, so only url-bearing entries are
// ingested — a stdio server's entry is silently skipped, not sent with a
// fabricated baseUrl. A missing `.mcp.json` (the common case) is expected,
// not an error worth logging.
async function ingestMcpServersFromConfig(cfg, mcpServerEntityTypeId, cwd) {
    let raw;
    try {
        raw = fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8');
    }
    catch {
        return;
    }
    let servers;
    try {
        servers = JSON.parse(raw)?.mcpServers || {};
    }
    catch {
        return;
    }
    for (const [name, entry] of Object.entries(servers)) {
        if (!entry?.url)
            continue; // stdio server, or malformed entry — nothing honest to send
        await postEntity(cfg, mcpServerEntityTypeId, name, [
            { name: 'description', value: `MCP server "${name}"` },
            { name: 'transport', value: 'http' },
            { name: 'baseUrl', value: entry.url },
            { name: 'connectionType', value: 'remote' },
        ]);
    }
}
const MCP_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
// Parses `claude mcp list`'s plain-text output — confirmed live there's no
// --json flag (`claude mcp list --help` doesn't offer one). One entry per
// line, shape confirmed from real output:
//   <name>: <url-or-command> [(<transport>)] - <status>
// e.g. "claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected"
//      "plugin:context7:context7: https://mcp.context7.com/mcp (HTTP) - ✔ Connected"
// The "Checking MCP server health…" banner and blank lines don't match and
// are silently skipped. A local/stdio server's exact line shape is
// unconfirmed (none configured on the machine this was written on) — its
// second token won't start with http(s):// either way, which is all this
// parser relies on to decide "nothing honest to ingest."
function parseMcpListOutput(output) {
    const entries = [];
    for (const line of output.split('\n')) {
        const match = line.match(/^(.+?):\s+(\S+)(?:\s+\([^)]*\))?\s+-\s+.+$/);
        if (!match)
            continue;
        const [, name, token] = match;
        entries.push({ name: name.trim(), url: /^https?:\/\//.test(token) ? token : undefined });
    }
    return entries;
}
// The only real way to see claude.ai account connectors (ElevenLabs,
// Unsplash, Google Drive/Gmail/Calendar, ...) — confirmed live these are
// NEVER written to ~/.claude.json, unlike local/project/user-scoped servers
// added via `claude mcp add`, so reading config files can't substitute for
// this. Split out from pollMcpServers so tests can inject a canned string
// instead of spawning the real CLI.
function runClaudeMcpList() {
    return (0, node_child_process_1.execFileSync)('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 15000 });
}
// Best-effort, throttled to once per MCP_POLL_INTERVAL_MS (persisted in the
// ingestion cache) — `claude mcp list` health-checks every connector live,
// too slow to run on every SessionStart. Only ingests names not already
// known; a server that later disappears from the list is left alone (no
// delete flow anywhere in this file — only POST/PATCH).
async function pollMcpServers(cfg, mcpServerEntityTypeId, pluginDataDir, listMcpServers = runClaudeMcpList) {
    const cached = loadIngestionCache(pluginDataDir);
    if (Date.now() - (cached?.lastMcpServersPolledAt ?? 0) < MCP_POLL_INTERVAL_MS) {
        (0, debug_1.debugLog)('pollMcpServers: not due yet');
        return;
    }
    let output;
    try {
        output = listMcpServers();
    }
    catch (err) {
        (0, debug_1.debugLog)(`pollMcpServers: \`claude mcp list\` failed — ${err}`);
        return;
    }
    const known = new Set(cached?.knownMcpServerNames || []);
    for (const entry of parseMcpListOutput(output)) {
        if (known.has(entry.name))
            continue;
        if (!entry.url) {
            known.add(entry.name); // local/stdio — nothing honest to ingest, stop re-checking it
            continue;
        }
        try {
            await postEntity(cfg, mcpServerEntityTypeId, entry.name, [
                { name: 'description', value: `MCP server "${entry.name}"` },
                { name: 'transport', value: 'http' },
                { name: 'baseUrl', value: entry.url },
                { name: 'connectionType', value: 'remote' },
            ]);
            known.add(entry.name);
        }
        catch (err) {
            (0, debug_1.debugLog)(`pollMcpServers: ingest "${entry.name}" failed — will retry next poll — ${err}`);
        }
    }
    saveIngestionCache({ lastMcpServersPolledAt: Date.now(), knownMcpServerNames: [...known] }, pluginDataDir);
}
