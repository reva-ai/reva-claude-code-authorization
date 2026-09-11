import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { debugLog } from './debug';
import { RevaConfig } from './types';

// Registers known entities (User, Agent, and — best-effort — MCPServer)
// with Reva's directory ahead of time, so evaluation requests aren't the
// first time the PDP hears about them. Called from sessionStart.ts, which
// treats every function here as best-effort: a failure must never block a
// Claude Code session from starting, unlike pdpClient.ts's evaluate().
//
// User is checked (GET) and ingested every session — NOT gated behind
// checkPrincipalExists()/principal/exists (that PDP-side check is gone for
// good; this uses a separate, ingestion-side GET instead). If the GET finds
// no User yet, one is created via a single POST with attributes:
// [{name: "active", value: "false"}, {name: "registeredMachineIds", value:
// machineId}, {name: "agents", value: agentId}] — no separate PATCH needed
// on that path, since every value can just be included at creation time.
// `active` is never touched again once created; this plugin has no way to
// vet a human, so it never claims the record is a real, active user — a
// human/admin verification flow on the Reva side is expected to flip that
// flag once the person is confirmed. If the GET finds a User already there,
// registeredMachineIds and agents are instead PATCH-ADDed, each on its own
// (both Sets — must accumulate, not overwrite, since a different machine or
// a different account may have registered one already), every session, so
// logging in from a new machine or a new account gets appended rather than
// replacing what's already there.
//
// Confirmed shapes (from the user, not guessed):
//   GET   {ingestionUrl}/policy-store/entity-types
//         -> [{id, name, schemaName}, ...]
//   POST  {ingestionUrl}/entity?entityTypeId={id}
//         body: { entityId, attributes: [{name,value}...], parents: [], children: [] }
//   PATCH {ingestionUrl}/entity/{entityId}?entityTypeId={id}
//         body: { attributeValue: {name, value}, op: "ADD", path: "ATTRIBUTE" }
//         used by addAttributeValue() below — exactly one attributeValue per
//         call, so updating N Set attributes on one entity is N separate
//         PATCH calls, not one. Confirmed uses: User.registeredMachineIds
//         and User.agents, both genuine Sets that must accumulate rather
//         than be overwritten. Also reused for Agent.agentType even though
//         that one is scalar (see ingestAgent() below) — this ADD-op PATCH
//         is the only write-an-attribute shape confirmed so far, so an
//         existing Agent's agentType is updated through it too rather than
//         inventing an unconfirmed "overwrite" shape.
//   GET   {ingestionUrl}/entity/{entityId}?entityTypeId={id}
//         -> 200 { id, entityType, source, ownerStoreId,
//                  entityAttributes: [{name,value}...], createdOn, updatedOn, name }
//         -> 404 or 400, both treated as not found (some backends return
//            400 rather than a clean 404 for an unresolvable entityId here)
//         used by entityExists() below — this response's attributes aren't
//         otherwise inspected, only whether the GET resolves 200 vs 404.

interface EntityTypeRecord {
  id: string;
  name: string;
  schemaName: string;
}

interface EntityAttribute {
  name: string;
  value: string;
}

interface IngestionCacheEntry {
  userEntityTypeId?: string;
  agentEntityTypeId?: string;
  mcpServerEntityTypeId?: string;
  // Epoch ms of the last successful `claude mcp list` poll (see
  // pollMcpServers) — throttles that check to once per MCP_POLL_INTERVAL_MS;
  // it shells out and health-checks every connector live, too slow to run
  // on every single SessionStart.
  lastMcpServersPolledAt?: number;
  // Server names already ingested, or confirmed local/stdio (nothing
  // ingestible), as of the last poll — so pollMcpServers only POSTs
  // genuinely new servers. A name that fails to ingest is deliberately left
  // out of this list so the next poll retries it.
  knownMcpServerNames?: string[];
}

// No fallback: only ever writes inside CLAUDE_PLUGIN_DATA (Claude Code's
// own per-plugin data directory — the officially documented mechanism for
// exactly this). Without it, there is nothing honest to write to — every
// change-signature check just always reports "changed," so ingestion is
// simply attempted fresh on every session rather than caching anything.
function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'entity-types') : undefined;
}

// Shared across every concurrently-open Claude Code session on the machine.
// Worst case on a cold-cache race between two sessions is a harmless
// duplicate GET/POST, not corruption.
function cacheFile(pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  return dir ? path.join(dir, 'catalog.json') : undefined;
}

function loadIngestionCache(pluginDataDir?: string): IngestionCacheEntry | undefined {
  const file = cacheFile(pluginDataDir);
  if (!file) return undefined;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as IngestionCacheEntry;
  } catch {
    return undefined;
  }
}

function saveIngestionCache(entry: IngestionCacheEntry, pluginDataDir?: string): void {
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(pluginDataDir);
  if (!dir || !file) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Merge onto whatever's already cached (entity-type ids and ingested
    // signatures are written independently, at different points in
    // sessionStart.ts's flow) rather than clobbering one with the other.
    const existing = loadIngestionCache(pluginDataDir) || {};
    fs.writeFileSync(file, JSON.stringify({ ...existing, ...entry }), 'utf8');
  } catch {
    // best effort — a fetch/ingest just happens again next session
  }
}

async function ingestionFetch(cfg: RevaConfig, url: string, method: string, body?: unknown): Promise<any> {
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
  } finally {
    clearTimeout(timer);
  }
}

async function fetchEntityTypes(cfg: RevaConfig): Promise<EntityTypeRecord[]> {
  const url = `${cfg.ingestionUrl}/policy-store/entity-types`;
  const raw = await ingestionFetch(cfg, url, 'GET');
  return Array.isArray(raw) ? raw : [];
}

// Resolves the entity-type ids ingestion calls need to pass as
// `entityTypeId`, caching them so a normal session start doesn't cost a
// network round-trip once they're known. Falls back to whatever was already
// cached if a fresh fetch fails.
export async function resolveEntityTypeIds(
  cfg: RevaConfig,
  pluginDataDir?: string,
): Promise<{ userEntityTypeId?: string; agentEntityTypeId?: string; mcpServerEntityTypeId?: string }> {
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
        debugLog(`resolveEntityTypeIds: multiple entity types named "${name}" — using the first (id=${matches[0].id})`);
      }
    }
    const entry: IngestionCacheEntry = {
      userEntityTypeId: types.find((t) => t.name === 'User')?.id,
      agentEntityTypeId: types.find((t) => t.name === 'Agent')?.id,
      mcpServerEntityTypeId: types.find((t) => t.name === 'MCPServer')?.id,
    };
    saveIngestionCache(entry, pluginDataDir);
    return entry;
  } catch {
    return cached || {};
  }
}

async function postEntity(cfg: RevaConfig, entityTypeId: string, entityId: string, attributes: EntityAttribute[]): Promise<void> {
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
async function addAttributeValue(cfg: RevaConfig, entityTypeId: string, entityId: string, attribute: EntityAttribute): Promise<void> {
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
async function entityExists(cfg: RevaConfig, entityTypeId: string, entityId: string): Promise<boolean> {
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
    if (res.status === 404 || res.status === 400) return false;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`ingestion GET entity returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return true;
  } finally {
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
export const AGENT_TYPE = 'ClaudeCode';

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
export async function ingestUser(
  cfg: RevaConfig,
  userEntityTypeId: string,
  userEmail: string,
  machineId: string,
  agentId: string,
): Promise<void> {
  const exists = await entityExists(cfg, userEntityTypeId, userEmail).catch((err) => {
    debugLog(`ingestUser: existence check failed (assuming exists, skipping create) — ${err}`);
    return true;
  });

  if (!exists) {
    await postEntity(cfg, userEntityTypeId, userEmail, [
      { name: 'active', value: 'false' },
      { name: 'registeredMachineIds', value: machineId },
      { name: 'agents', value: agentId },
    ]).catch((err) => debugLog(`ingestUser: POST failed — ${err}`));
  } else {
    await addAttributeValue(cfg, userEntityTypeId, userEmail, { name: 'registeredMachineIds', value: machineId }).catch(
      (err) => debugLog(`ingestUser: PATCH registeredMachineIds failed — ${err}`),
    );
    await addAttributeValue(cfg, userEntityTypeId, userEmail, { name: 'agents', value: agentId }).catch((err) =>
      debugLog(`ingestUser: PATCH agents failed — ${err}`),
    );
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
export async function ingestAgent(cfg: RevaConfig, agentEntityTypeId: string, agentId: string, userEmail: string): Promise<void> {
  const exists = await entityExists(cfg, agentEntityTypeId, agentId).catch((err) => {
    debugLog(`ingestAgent: existence check failed (assuming exists, skipping create) — ${err}`);
    return true;
  });

  if (!exists) {
    await postEntity(cfg, agentEntityTypeId, agentId, [
      { name: 'user', value: userEmail },
      { name: 'agentType', value: AGENT_TYPE },
    ]).catch((err) => debugLog(`ingestAgent: POST failed — ${err}`));
  } else {
    await addAttributeValue(cfg, agentEntityTypeId, agentId, { name: 'agentType', value: AGENT_TYPE }).catch((err) =>
      debugLog(`ingestAgent: PATCH agentType failed — ${err}`),
    );
  }
}

interface McpJsonServerEntry {
  url?: string;
  [key: string]: any;
}

// Best-effort, partial: `.mcp.json` only ever gives a server *name* plus
// either a `url` (remote/http) or `command`/`args` (stdio, no URL at all).
// MCPServer's schema requires `baseUrl`, so only url-bearing entries are
// ingested — a stdio server's entry is silently skipped, not sent with a
// fabricated baseUrl. A missing `.mcp.json` (the common case) is expected,
// not an error worth logging.
export async function ingestMcpServersFromConfig(cfg: RevaConfig, mcpServerEntityTypeId: string, cwd: string): Promise<void> {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8');
  } catch {
    return;
  }

  let servers: Record<string, McpJsonServerEntry>;
  try {
    servers = JSON.parse(raw)?.mcpServers || {};
  } catch {
    return;
  }

  for (const [name, entry] of Object.entries(servers)) {
    if (!entry?.url) continue; // stdio server, or malformed entry — nothing honest to send
    await postEntity(cfg, mcpServerEntityTypeId, name, [
      { name: 'description', value: `MCP server "${name}"` },
      { name: 'transport', value: 'http' },
      { name: 'baseUrl', value: entry.url },
      { name: 'connectionType', value: 'remote' },
    ]);
  }
}

const MCP_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface McpListEntry {
  name: string;
  // undefined for a local/stdio server (its second token isn't a URL) —
  // kept in the parsed list rather than dropped, so pollMcpServers can mark
  // it "known" and stop re-checking it, without ever inventing a baseUrl.
  url?: string;
}

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
export function parseMcpListOutput(output: string): McpListEntry[] {
  const entries: McpListEntry[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^(.+?):\s+(\S+)(?:\s+\([^)]*\))?\s+-\s+.+$/);
    if (!match) continue;
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
function runClaudeMcpList(): string {
  return execFileSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 15000 });
}

// Best-effort, throttled to once per MCP_POLL_INTERVAL_MS (persisted in the
// ingestion cache) — `claude mcp list` health-checks every connector live,
// too slow to run on every SessionStart. Only ingests names not already
// known; a server that later disappears from the list is left alone (no
// delete flow anywhere in this file — only POST/PATCH).
export async function pollMcpServers(
  cfg: RevaConfig,
  mcpServerEntityTypeId: string,
  pluginDataDir?: string,
  listMcpServers: () => string = runClaudeMcpList,
): Promise<void> {
  const cached = loadIngestionCache(pluginDataDir);
  if (Date.now() - (cached?.lastMcpServersPolledAt ?? 0) < MCP_POLL_INTERVAL_MS) {
    debugLog('pollMcpServers: not due yet');
    return;
  }

  let output: string;
  try {
    output = listMcpServers();
  } catch (err) {
    debugLog(`pollMcpServers: \`claude mcp list\` failed — ${err}`);
    return;
  }

  const known = new Set(cached?.knownMcpServerNames || []);
  for (const entry of parseMcpListOutput(output)) {
    if (known.has(entry.name)) continue;
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
    } catch (err) {
      debugLog(`pollMcpServers: ingest "${entry.name}" failed — will retry next poll — ${err}`);
    }
  }

  saveIngestionCache({ lastMcpServersPolledAt: Date.now(), knownMcpServerNames: [...known] }, pluginDataDir);
}
