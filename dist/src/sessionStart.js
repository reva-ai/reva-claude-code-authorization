"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const activeSessions_1 = require("./activeSessions");
const config_1 = require("./config");
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const ingestionClient_1 = require("./ingestionClient");
const identity_1 = require("./identity");
const stdin_1 = require("./stdin");
async function main() {
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
        // No separate ingestion token/gate: the same auth token that's already
        // required for evaluation authenticates ingestion too, so ingestion is
        // attempted whenever the plugin is configured at all.
        const cfg = (0, config_1.loadConfig)();
        const userEmail = (0, identity_1.resolveUserEmail)();
        try {
            const { userEntityTypeId, agentEntityTypeId, mcpServerEntityTypeId } = await (0, ingestionClient_1.resolveEntityTypeIds)(cfg, pluginDataDir);
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
                await (0, ingestionClient_1.ingestUser)(cfg, userEntityTypeId, userEmail, machineId, cfg.agentId).catch((err) => (0, debug_1.debugLog)(`sessionStart: ingest User failed — ${err}`));
            }
            if (!agentEntityTypeId) {
                (0, debug_1.debugLog)('sessionStart: skipped Agent ingestion — could not resolve entity type id');
            }
            else {
                // userEmail here is ALSO sent as an ATTRIBUTE on the Agent entity
                // (a reference back to who's using this machine) — separate from,
                // and in addition to, the direct User ingestion above.
                await (0, ingestionClient_1.ingestAgent)(cfg, agentEntityTypeId, cfg.agentId, userEmail).catch((err) => (0, debug_1.debugLog)(`sessionStart: ingest Agent failed — ${err}`));
            }
            if (mcpServerEntityTypeId) {
                await (0, ingestionClient_1.ingestMcpServersFromConfig)(cfg, mcpServerEntityTypeId, input.cwd).catch((err) => (0, debug_1.debugLog)(`sessionStart: ingest MCPServers failed — ${err}`));
                // Throttled to once per 4h internally (see pollMcpServers) — safe to
                // call on every SessionStart, most calls are a no-op cache check.
                await (0, ingestionClient_1.pollMcpServers)(cfg, mcpServerEntityTypeId, pluginDataDir).catch((err) => (0, debug_1.debugLog)(`sessionStart: poll claude mcp list failed — ${err}`));
            }
        }
        catch (err) {
            (0, debug_1.debugLog)(`sessionStart: ingestion error — continuing (${err?.message || String(err)})`);
        }
    }
    catch (err) {
        (0, debug_1.debugLog)(`sessionStart: unexpected error — continuing (${err?.message || String(err)})`);
    }
    process.exit(0); // clean no-op pass-through — no stdout, nothing to block on
}
main().catch(() => process.exit(0));
