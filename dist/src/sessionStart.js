"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const config_1 = require("./config");
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const ingestionClient_1 = require("./ingestionClient");
const identity_1 = require("./identity");
const mcpIngestionTrigger_1 = require("./mcpIngestionTrigger");
const mcpServerIdentity_1 = require("./mcpServerIdentity");
const runtimeScope_1 = require("./runtimeScope");
const stdin_1 = require("./stdin");
async function main() {
    if ((0, runtimeScope_1.skipOutsideCodeScope)())
        return;
    const raw = await (0, stdin_1.readStdin)();
    const input = JSON.parse(raw);
    const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
    // Independent of Reva config being valid at all — this is purely local
    // bookkeeping (which session_ids are active on this machine right now),
    // resolved the same way loadConfig() would derive agentId (same
    // REVA_AGENT_ID precedence), but without needing the rest of loadConfig()
    // to succeed first. resolveAgentId() has no fallback (see deviceId.ts) —
    // if neither REVA_AGENT_ID nor an OAuth account is available, there's no
    // honest id to key this local cache by, so tracking is skipped for this
    // session rather than guessing one.
    // Warm the uuid -> MCP server identity map BEFORE this hook returns, so
    // the very first tool call of the session already resolves
    // mcp__<uuid>__<tool> to a real slug. ingestMcpServers.ts refreshes this
    // too, but it is detached: without this, tool calls racing ahead of that
    // child emit the raw uuid while later ones emit the slug, putting ONE
    // connector under two different ids inside a single session's audit
    // trail. Measured at 66-99ms of purely local file I/O on a real machine
    // with 27 desktop session files — cheap next to the network calls this
    // hook already blocks on, and worth it to make the ids consistent.
    //
    // Deliberately before loadConfig(): this is local bookkeeping that must
    // work on a machine with no valid Reva token at all.
    try {
        (0, mcpServerIdentity_1.refreshMcpServerIdentityCache)(pluginDataDir);
    }
    catch (err) {
        (0, debug_1.debugLog)(`sessionStart: MCP server identity refresh failed — continuing (${err?.message || String(err)})`);
    }
    const agentId = process.env.REVA_AGENT_ID || (0, deviceId_1.resolveAgentId)();
    if (!agentId) {
        (0, debug_1.debugLog)('sessionStart: skipped active-session tracking — no Anthropic account logged in and REVA_AGENT_ID not set');
    }
    else {
        try {
            (0, activeSessions_1.markSessionActive)(agentId, input.session_id, process.env.CLAUDE_CODE_ENTRYPOINT || 'unknown', pluginDataDir);
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionStart: markSessionActive failed — ${err?.message || String(err)}`);
        }
    }
    try {
        // loadConfig() throws if the auth token or agentId is missing —
        // expected and common here, since a session can start perfectly well
        // with nothing configured at all yet. Caught below, same as any other
        // best-effort ingestion failure, rather than treated as a special case.
        const cfg = (0, config_1.loadConfig)();
        // Forced fresh fetch, replacing whatever's cached, once per session —
        // plain and simple: rather than only reacting after something has
        // already failed against a stale cached id (a policy-store/tenant
        // migration reassigns these ids server-side — see
        // invalidateStaleIngestionCache's own comment), this makes sure the
        // ids are never stale to begin with for the rest of this session.
        // Done BEFORE spawning MCP ingestion below so that detached child
        // reads the freshly-replaced cache, not whatever was cached before
        // this session started.
        const { userEntityTypeId, agentEntityTypeId } = await (0, ingestionClient_1.resolveEntityTypeIds)(cfg, pluginDataDir, true);
        // Started before the blocking work below so its own latency overlaps
        // with it instead of stacking on top of it. Unconditional, every
        // session — but still records the trigger time (same field a throttled
        // UserPromptSubmit recheck reads — see mcpIngestionTrigger.ts) so that
        // recheck doesn't immediately re-trigger on this session's very first
        // prompt, moments after this same pass just started.
        (0, mcpIngestionTrigger_1.spawnMcpIngestion)(input.cwd || process.cwd(), pluginDataDir);
        (0, ingestionClient_1.recordMcpDiscoveryTriggered)(pluginDataDir);
        const userEmail = (0, identity_1.resolveUserEmail)();
        try {
            const tasks = [];
            if (!userEntityTypeId) {
                (0, debug_1.debugLog)('sessionStart: skipped User ingestion — could not resolve entity type id');
            }
            else {
                // machineId is THIS machine's hardware id, deliberately not
                // cfg.agentId (the account id) — registeredMachineIds needs to
                // distinguish machines, which the account id can't do since it's
                // the same across every machine the account uses. cfg.agentId is
                // passed too, separately, so ingestUser() can link this User back
                // to its Agent(s) via the User.agents attribute — a different
                // relationship than registeredMachineIds, so a different parameter.
                const machineId = (0, deviceId_1.resolveMachineId)(pluginDataDir);
                tasks.push((0, ingestionClient_1.ingestUser)(cfg, userEntityTypeId, userEmail, machineId, cfg.agentId, pluginDataDir).catch((err) => (0, debug_1.debugLog)(`sessionStart: ingest User failed — ${err}`)));
            }
            if (!agentEntityTypeId) {
                (0, debug_1.debugLog)('sessionStart: skipped Agent ingestion — could not resolve entity type id');
            }
            else {
                // userEmail here is ALSO sent as an ATTRIBUTE on the Agent entity
                // (a reference back to who's using this machine) — separate from,
                // and in addition to, the direct User ingestion above.
                tasks.push((0, ingestionClient_1.ingestAgent)(cfg, agentEntityTypeId, cfg.agentId, userEmail, pluginDataDir).catch((err) => (0, debug_1.debugLog)(`sessionStart: ingest Agent failed — ${err}`)));
            }
            // User and Agent are different entities with no shared writes between
            // them, so they run concurrently — this process waits for the slower
            // of the two, not their sum.
            await Promise.all(tasks);
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionStart: ingestion error — continuing (${err?.message || String(err)})`);
        }
    }
    catch (err) {
        (0, debug_1.debugLog)(`sessionStart: unexpected error — continuing (${err?.message || String(err)})`);
    }
    process.exit(0); // no stdout either way — nothing for Claude Code to act on
}
main().catch(() => process.exit(0));
