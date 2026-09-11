import { markSessionActive } from './activeSessions';
import { loadConfig } from './config';
import { debugLog } from './debug';
import { resolveAgentId, resolveMachineId } from './deviceId';
import {
  ingestAgent,
  ingestMcpServersFromConfig,
  ingestUser,
  pollMcpServers,
  resolveEntityTypeIds,
} from './ingestionClient';
import { resolveUserEmail } from './identity';
import { readStdin } from './stdin';

// SessionStart has no blocking/decision control at all (confirmed against
// Claude Code's docs) — it's context-only. So unlike authorize.ts and
// authorizePrompt.ts, nothing in this file may ever throw out of main():
// every ingestion attempt is wrapped so one failure can't stop the next,
// and the whole function always ends in
// a clean, silent exit.
//
// User and Agent ingestion both run every session, unconditionally — no
// local change-detection cache for either. ingestUser()/ingestAgent()
// (ingestionClient.ts) each do their own GET-then-branch against the
// ingestion API directly (not the removed PDP-side principal/exists
// check), so the live GET result is the only source of truth for whether
// a POST is actually needed — a local "already did this" flag would just
// go stale the moment the record is deleted/changed on the Reva side.

interface SessionStartInput {
  session_id: string;
  cwd: string;
  source?: string;
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input: SessionStartInput = JSON.parse(raw);
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  // Independent of Reva config being valid at all — this is purely local
  // bookkeeping (which session_ids are active on this machine right now),
  // resolved the same way loadConfig() would derive agentId (same
  // REVA_AGENT_ID precedence), but without needing the rest of loadConfig()
  // to succeed first. resolveAgentId() has no fallback (see deviceId.ts) —
  // if neither REVA_AGENT_ID nor an OAuth account is available, there's no
  // honest id to key this local cache by, so tracking is skipped for this
  // session rather than guessing one.
  const agentId = process.env.REVA_AGENT_ID || resolveAgentId();
  if (!agentId) {
    debugLog('sessionStart: skipped active-session tracking — no Anthropic account logged in and REVA_AGENT_ID not set');
  } else {
    try {
      markSessionActive(agentId, input.session_id, process.env.CLAUDE_CODE_ENTRYPOINT || 'unknown', pluginDataDir);
    } catch (err: any) {
      debugLog(`sessionStart: markSessionActive failed — ${err?.message || String(err)}`);
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
    const cfg = loadConfig();
    const userEmail = resolveUserEmail();

    try {
      const { userEntityTypeId, agentEntityTypeId, mcpServerEntityTypeId } = await resolveEntityTypeIds(cfg, pluginDataDir);

      if (!userEntityTypeId) {
        debugLog('sessionStart: skipped User ingestion — could not resolve entity type id');
      } else {
        // machineId is THIS machine's hardware id, deliberately not
        // cfg.agentId (the account id) — registeredMachineIds needs to
        // distinguish machines, which the account id can't do since it's
        // the same across every machine the account uses. cfg.agentId is
        // passed too, separately, so ingestUser() can link this User back
        // to its Agent(s) via the User.agents attribute — a different
        // relationship than registeredMachineIds, so a different parameter.
        const machineId = resolveMachineId(pluginDataDir);
        await ingestUser(cfg, userEntityTypeId, userEmail, machineId, cfg.agentId).catch((err) =>
          debugLog(`sessionStart: ingest User failed — ${err}`),
        );
      }

      if (!agentEntityTypeId) {
        debugLog('sessionStart: skipped Agent ingestion — could not resolve entity type id');
      } else {
        // userEmail here is ALSO sent as an ATTRIBUTE on the Agent entity
        // (a reference back to who's using this machine) — separate from,
        // and in addition to, the direct User ingestion above.
        await ingestAgent(cfg, agentEntityTypeId, cfg.agentId, userEmail).catch((err) =>
          debugLog(`sessionStart: ingest Agent failed — ${err}`),
        );
      }

      if (mcpServerEntityTypeId) {
        await ingestMcpServersFromConfig(cfg, mcpServerEntityTypeId, input.cwd).catch((err) =>
          debugLog(`sessionStart: ingest MCPServers failed — ${err}`),
        );
        // Throttled to once per 4h internally (see pollMcpServers) — safe to
        // call on every SessionStart, most calls are a no-op cache check.
        await pollMcpServers(cfg, mcpServerEntityTypeId, pluginDataDir).catch((err) =>
          debugLog(`sessionStart: poll claude mcp list failed — ${err}`),
        );
      }
    } catch (err: any) {
      debugLog(`sessionStart: ingestion error — continuing (${err?.message || String(err)})`);
    }
  } catch (err: any) {
    debugLog(`sessionStart: unexpected error — continuing (${err?.message || String(err)})`);
  }

  process.exit(0); // clean no-op pass-through — no stdout, nothing to block on
}

main().catch(() => process.exit(0));
