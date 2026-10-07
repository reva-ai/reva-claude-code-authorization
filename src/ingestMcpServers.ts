import { loadConfig } from './config';
import { debugLog } from './debug';
import { ingestDiscoveredMcpServers, resolveEntityTypeIds } from './ingestionClient';
import { discoverMcpServers, DiscoveredMcpServer } from './mcpDiscovery';
import { resolveUserEmail } from './identity';
import { refreshMcpServerIdentityCache } from './mcpServerIdentity';
import { skipOutsideCodeScope } from './runtimeScope';

// MCP server discovery — deliberately split out from sessionStart.ts's own
// blocking User/Agent ingestion (see the comment there) and run as a
// detached child process instead. Discovery itself (mcpDiscovery.ts) is now
// just a handful of local file reads, genuinely fast — but *ingesting* what
// it finds still means a network call to Reva per newly-discovered server
// (a PATCH onto the User entity, and often a POST for the MCPServer entity
// itself), sequentially, one server at a time. On a session with several
// new servers that's still the least bounded part of ingestion, and not
// something any known policy needs before a session can proceed. By the
// time this process starts, sessionStart.js has already exited, so however
// long this takes, or however it fails, cannot block a session again.
//
// cwd arrives via REVA_SESSION_CWD (set by the spawning sessionStart.ts)
// rather than stdin — this process has no hook input of its own to read.

async function main(): Promise<void> {
  if (skipOutsideCodeScope()) return;
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  const cwd = process.env.REVA_SESSION_CWD || process.cwd();

  // What this pass ingests: everything discovery finds, PLUS the server whose
  // tool just got invoked, when the PreToolUse path spawned us with one.
  //
  // That addition was the whole point of ingest-on-invoke: discovery reads
  // config files, so it structurally CANNOT see an app-provided server —
  // Claude_Browser, claude-in-chrome, the iOS simulator — or a plugin's own
  // bundled server. Those exist only as evidence in a tool name. These never
  // have a url, though, and ingestDiscoveredMcpServers() now ignores any
  // entry without one entirely (see its own comment) — so in practice this
  // addition no longer changes what gets ingested. It is kept anyway,
  // harmlessly: it still reaches the identity cache below with no url,
  // which is the same answer a cache miss would already give.
  const invoked = process.env.REVA_INVOKED_MCP_SERVER?.trim();
  const discovered = discoverMcpServers(cwd);
  const withInvoked: DiscoveredMcpServer[] =
    !invoked || discovered.some((entry) => entry.name === invoked)
      ? discovered
      : [...discovered, { name: invoked, displayName: invoked, url: undefined }];
  if (withInvoked !== discovered) {
    debugLog(`ingestMcpServers: including invoked-but-undiscoverable server "${invoked}"`);
  }
  const discover = (): DiscoveredMcpServer[] => withInvoked;

  // Rebuild the identity map FIRST, before anything that can fail on config
  // or network — this is what lets the PreToolUse path resolve
  // mcp__<uuid>__<tool> to a real slug and url (for a claude.ai connector),
  // and mcp__<name>__<tool> to a real url too (for anything file-based
  // discovery just found). Deliberately done here, in this detached child,
  // rather than in the hook itself: the desktop session files the connector
  // half reads are ~0.5-1 MB each (they embed full tool schemas), which has
  // no business on a blocking authorization path. Unconditional and
  // independent of Reva config — a machine with no valid token at all still
  // gets correct names (and a correct skip decision) in its local audit
  // trail.
  try {
    refreshMcpServerIdentityCache(pluginDataDir, withInvoked);
  } catch (err: any) {
    debugLog(`ingestMcpServers: MCP server identity refresh failed — continuing (${err?.message || String(err)})`);
  }

  try {
    const cfg = loadConfig();
    const userEmail = resolveUserEmail();

    const { userEntityTypeId, mcpServerEntityTypeId } = await resolveEntityTypeIds(cfg, pluginDataDir);

    if (!mcpServerEntityTypeId) {
      debugLog('ingestMcpServers: skipped — could not resolve MCPServer entity type id');
    } else {
      // userEntityTypeId/userEmail are passed through so every genuinely
      // new server name also gets PATCH-ADDed onto the User entity as
      // registeredMcpServers — undefined userEntityTypeId (couldn't be
      // resolved above) just skips that PATCH, still ingests the MCPServer
      // entities themselves.
      await ingestDiscoveredMcpServers(cfg, mcpServerEntityTypeId, cwd, pluginDataDir, userEntityTypeId, userEmail, discover).catch(
        (err) => debugLog(`ingestMcpServers: ingest discovered MCP servers failed — ${err}`),
      );
    }
  } catch (err: any) {
    debugLog(`ingestMcpServers: unexpected error — continuing (${err?.message || String(err)})`);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
