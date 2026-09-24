import { markSessionActive } from './activeSessions';
import { loadConfig } from './config';
import { debugLog } from './debug';
import { resolveAgentId, resolveMachineId } from './deviceId';
import { ingestAgent, ingestUser, recordMcpDiscoveryTriggered, resolveEntityTypeIds } from './ingestionClient';
import { resolveUserEmail } from './identity';
import { spawnMcpIngestion } from './mcpIngestionTrigger';
import { refreshMcpServerIdentityCache } from './mcpServerIdentity';
import { skipOutsideCodeScope } from './runtimeScope';
import { readStdin } from './stdin';

// SessionStart has no blocking/decision control at all (confirmed against
// Claude Code's docs) — but unlike a plain no-op, this hook now
// deliberately waits for User/Agent ingestion before exiting: Cedar
// policies that check a STORED registration (e.g. "is this machineId on
// User.registeredMachineIds") need that PATCH to have already landed on
// Reva's side, since the request's own inline context.machineId/os only
// proves what the client claims, not what's on record. resolveEntityTypeIds
// + ingestUser + ingestAgent are the fast, correctness-critical half of
// ingestion — User and Agent run concurrently (different entities, no
// shared writes) rather than one after another, so the worst case here is
// bounded by the slower of the two, not their sum.
//
// MCP server discovery (ingestMcpServers.ts) is deliberately NOT part of
// this wait: discovering *what's* configured is fast, file-based, and no
// longer depends on the `claude` CLI being installed at all (see
// mcpDiscovery.ts) — but *ingesting* what it finds still means a network
// call to Reva (now batched into at most one bulk PATCH and one bulk POST
// per pass — see ingestDiscoveredMcpServers), still not something any
// known policy here needs before the session can proceed. It's spawned
// below as a fully detached, unref'd child — after the forced entity-type
// refresh just above, not before, so that child reads the freshly-
// replaced cache rather than whatever was there before this session
// started; still before this process's own remaining blocking work
// (ingestUser/ingestAgent) so its independent latency overlaps rather
// than stacks on top of that.

interface SessionStartInput {
  session_id: string;
  cwd: string;
  source?: string;
}

async function main(): Promise<void> {
  if (skipOutsideCodeScope()) return;
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
  // Warm the uuid -> MCP server identity map BEFORE this hook returns, so
  // the very first tool call of the session already resolves
  // mcp__<uuid>__<tool> to a real slug. ingestMcpServers.ts refreshes this
  // too, but it is detached: without this, tool calls racing ahead of that
  // child emit the raw uuid while later ones emit the slug, putting ONE
  // connector under two different ids inside a single session's audit
  // trail. Measured in the tens of milliseconds of purely local file I/O —
  // cheap next to the network calls this hook already blocks on, and worth
  // it to make the ids consistent.
  //
  // Deliberately before loadConfig(): this is local bookkeeping that must
  // work on a machine with no valid Reva token at all.
  try {
    refreshMcpServerIdentityCache(pluginDataDir);
  } catch (err: any) {
    debugLog(`sessionStart: MCP server identity refresh failed — continuing (${err?.message || String(err)})`);
  }

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
    const cfg = loadConfig();

    // Forced fresh fetch, replacing whatever's cached, once per session —
    // plain and simple: rather than only reacting after something has
    // already failed against a stale cached id (a policy-store/tenant
    // migration reassigns these ids server-side — see
    // invalidateStaleIngestionCache's own comment), this makes sure the
    // ids are never stale to begin with for the rest of this session.
    // Done BEFORE spawning MCP ingestion below so that detached child
    // reads the freshly-replaced cache, not whatever was cached before
    // this session started.
    const { userEntityTypeId, agentEntityTypeId } = await resolveEntityTypeIds(cfg, pluginDataDir, true);

    // Started before the blocking work below so its own latency overlaps
    // with it instead of stacking on top of it. Unconditional, every
    // session — but still records the trigger time (same field a throttled
    // UserPromptSubmit recheck reads — see mcpIngestionTrigger.ts) so that
    // recheck doesn't immediately re-trigger on this session's very first
    // prompt, moments after this same pass just started.
    spawnMcpIngestion(input.cwd || process.cwd(), pluginDataDir);
    recordMcpDiscoveryTriggered(pluginDataDir);

    const userEmail = resolveUserEmail();

    try {
      const tasks: Promise<void>[] = [];

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
        tasks.push(
          ingestUser(cfg, userEntityTypeId, userEmail, machineId, cfg.agentId, pluginDataDir).catch((err) =>
            debugLog(`sessionStart: ingest User failed — ${err}`),
          ),
        );
      }

      if (!agentEntityTypeId) {
        debugLog('sessionStart: skipped Agent ingestion — could not resolve entity type id');
      } else {
        // userEmail here is ALSO sent as an ATTRIBUTE on the Agent entity
        // (a reference back to who's using this machine) — separate from,
        // and in addition to, the direct User ingestion above.
        tasks.push(
          ingestAgent(cfg, agentEntityTypeId, cfg.agentId, userEmail, pluginDataDir).catch((err) =>
            debugLog(`sessionStart: ingest Agent failed — ${err}`),
          ),
        );
      }

      // User and Agent are different entities with no shared writes between
      // them, so they run concurrently — this process waits for the slower
      // of the two, not their sum.
      await Promise.all(tasks);
    } catch (err: any) {
      debugLog(`sessionStart: ingestion error — continuing (${err?.message || String(err)})`);
    }
  } catch (err: any) {
    debugLog(`sessionStart: unexpected error — continuing (${err?.message || String(err)})`);
  }

  process.exit(0); // no stdout either way — nothing for Claude Code to act on
}

main().catch(() => process.exit(0));
