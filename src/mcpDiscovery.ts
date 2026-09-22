import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readDesktopConnectors, slugifyMcpServerName } from './mcpServerIdentity';

// Pure, synchronous, file-based MCP server discovery — no CLI, no network,
// no live health-check. Replaces the old `claude mcp list` shell-out, which
// only worked when the standalone CLI happened to be installed and on PATH;
// Cowork and Desktop-app-only setups often have neither.
//
// Deliberately NOT covered: MCP servers bundled inside a plugin (e.g.
// "plugin:context7:context7" in claude mcp list's output). Confirmed live
// that Claude itself does count those as real MCP server entries — this
// isn't a correctness fix, it's a scope decision: a plugin's own bundled
// server isn't something the user directly configured, so it's excluded on
// purpose, not because it's technically undetectable (it would just mean
// reading that plugin's own .mcp.json, same mechanics as everything below).
//
// Every name returned here is a SLUG (see mcpServerIdentity.ts) — the same
// canonical id mapping.ts emits at invoke time, so the inventory side and
// the enforcement side finally join. The original spelling rides along as
// displayName; nothing is lost, it just stops being the key.
//
// Six sources, each best-effort and independently fault-tolerant — a
// missing or malformed file just contributes nothing, never an error:
//   1. Project-scoped:  <cwd>/.mcp.json
//   2. User-scoped:     ~/.claude.json            -> mcpServers
//   3. Local-scoped:    ~/.claude.json             -> projects[cwd].mcpServers
//   4. claude.ai account connectors (Gmail, Drive, Calendar, ...):
//      ~/.claude.json -> claudeAiMcpEverConnected
//      This one lags: live-confirmed a freshly-added connector wasn't
//      reflected here immediately, though a later check confirmed it does
//      catch up. Accepted anyway, same reasoning as everything else here —
//      no dependency on the CLI — and the delay is tolerable since this
//      gets PATCHed onto an accumulating Set (registeredMcpServers), not
//      read as a point-in-time snapshot: a late catch-up still lands
//      correctly, just later than the session the connector was actually
//      added in.
//   5. Enabled built-in capabilities (e.g. "computer-use" — desktop
//      control): ~/.claude.json -> projects[*].enabledMcpServers
//      A different shape than sources 2/3 above: a plain array of names,
//      not a name->config dictionary — these are product-level
//      capabilities toggled on per project, confirmed live to exist with
//      no corresponding mcpServers dictionary entry at all, so sources 2/3
//      never see them. Scanned across EVERY project entry, not just cwd's
//      — unlike local-scope mcpServers just above (deliberately per-repo,
//      matching `claude mcp add --scope local`'s own semantics), a
//      capability like desktop control being enabled anywhere on this
//      machine is exactly what a governance tool needs visibility into
//      account-wide, not scoped to whichever repo happens to be open right
//      now — same reasoning as claudeAiConnectorServers() being global.
//   6. claude.ai connectors as the DESKTOP APP records them:
//      <sessions>/<account>/<org>/local_*.json -> remoteMcpServersConfig
//      Strictly richer than source 4 for the same connectors: it carries the
//      uuid that actually appears in tool names, the display name, AND a real
//      url — so these can finally become full MCPServer entities with a
//      baseUrl instead of bare names on a Set. It's also current rather than
//      "ever connected": live-confirmed it caught `visualize`, connected but
//      absent from claudeAiMcpEverConnected, while that list still carried a
//      Google Drive that wasn't connected any more. Source 4 is kept anyway
//      — it's the only one of the two that survives on a non-macOS or
//      CLI-only host, where these files don't exist at all.

export interface DiscoveredMcpServer {
  // The server's canonical id, matching what mapping.ts emits at invoke
  // time. For a claude.ai connector this is a slug derived from its display
  // name ("claude.ai Gmail" and the uuid d521f7ee-… both land on "gmail");
  // for everything else it is the configured key, verbatim.
  name: string;
  // Present for a remote/http server; absent for stdio/local-only, an
  // enabled built-in capability, or any malformed entry — never fabricated.
  // Each of those is still genuinely "configured for this user" even with no
  // url to report (see callers). claude.ai connectors DO have one now, via
  // source 6.
  url?: string;
  // The name as it was actually written wherever it was found, before
  // slugging — kept so the entity stays readable in Reva.
  displayName?: string;
  // Anthropic's global connector id, for source 6 only.
  uuid?: string;
}

interface McpJsonServerEntry {
  url?: string;
  [key: string]: any;
}

function claudeJsonPath(): string {
  return process.env.REVA_CLAUDE_JSON_PATH?.length ? process.env.REVA_CLAUDE_JSON_PATH : path.join(os.homedir(), '.claude.json');
}

function readJsonFile(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function toDiscovered(servers: Record<string, McpJsonServerEntry> | undefined): DiscoveredMcpServer[] {
  if (!servers || typeof servers !== 'object') return [];
  // Slugged, same as every other source — mapping.ts slugs the matching
  // token at invoke time, so the two still meet. See mcpServerIdentity.ts for
  // the collision trade-off this accepts.
  return Object.entries(servers).map(([name, entry]) => ({
    name: slugifyMcpServerName(name) || name,
    displayName: name,
    url: typeof entry?.url === 'string' ? entry.url : undefined,
  }));
}

function mcpJsonFileServers(filePath: string): DiscoveredMcpServer[] {
  return toDiscovered(readJsonFile(filePath)?.mcpServers);
}

function projectServers(cwd: string): DiscoveredMcpServer[] {
  return mcpJsonFileServers(path.join(cwd, '.mcp.json'));
}

// User-scope (`claude mcp add --scope user`) and local-scope (`--scope
// local`) both live inside the same ~/.claude.json — user-scope at the top
// level, local-scope nested per project path — so one read covers both.
function userAndLocalScopeServers(cwd: string): DiscoveredMcpServer[] {
  const data = readJsonFile(claudeJsonPath());
  if (!data) return [];
  return [...toDiscovered(data.mcpServers), ...toDiscovered(data.projects?.[cwd]?.mcpServers)];
}

// claude.ai account connectors never appear in .mcp.json or in
// ~/.claude.json's own mcpServers/projects[cwd].mcpServers — those are only
// ever populated by `claude mcp add`. claudeAiMcpEverConnected is the one
// local record of these (see the file-level comment above for its lag).
// No url — these are account-level connectors, not something with a local
// baseUrl the way a `claude mcp add --transport http` entry has.
function claudeAiConnectorServers(): DiscoveredMcpServer[] {
  const names = readJsonFile(claudeJsonPath())?.claudeAiMcpEverConnected;
  if (!Array.isArray(names)) return [];
  return names
    .filter((n): n is string => typeof n === 'string' && n.length > 0)
    .map((name) => ({
      // "claude.ai Google Drive" -> "google-drive" — the same slug source 6
      // derives from the display name "Google Drive", so the two sources
      // de-duplicate against each other instead of double-ingesting one
      // connector under two spellings.
      name: slugifyMcpServerName(name) || name,
      displayName: name.replace(/^claude\.ai\s+/i, '') || name,
      url: undefined,
    }));
}

// Source 6 — see the file-level comment. The uuid here is the one that
// actually appears in tool names at invoke time, which is what makes this
// the source that closes the discovery/enforcement gap.
function desktopConnectorServers(): DiscoveredMcpServer[] {
  return readDesktopConnectors().map((connector) => ({
    name: slugifyMcpServerName(connector.name) || connector.uuid,
    displayName: connector.name,
    url: connector.url,
    uuid: connector.uuid,
  }));
}

// See the file-level comment's source #5 for what this is and why it's
// scanned globally rather than scoped to cwd, unlike userAndLocalScopeServers
// above. No url — same as a claude.ai connector: a built-in capability has
// no baseUrl of its own, still genuinely "enabled for this user."
function enabledBuiltinServers(): DiscoveredMcpServer[] {
  const projects = readJsonFile(claudeJsonPath())?.projects;
  if (!projects || typeof projects !== 'object') return [];
  const names = new Set<string>();
  for (const project of Object.values(projects)) {
    const enabled = (project as { enabledMcpServers?: unknown } | undefined)?.enabledMcpServers;
    if (!Array.isArray(enabled)) continue;
    for (const name of enabled) {
      if (typeof name === 'string' && name.length > 0) names.add(name);
    }
  }
  return [...names].map((name) => ({ name: slugifyMcpServerName(name) || name, displayName: name, url: undefined }));
}

// First occurrence wins on a slug collision across sources — deterministic,
// and the ORDER is now load-bearing rather than arbitrary: source 6 runs
// before source 4 because both describe the same claude.ai connectors, and
// 6's entry is strictly richer (uuid + display name + real url, vs. a bare
// prefixed name). Letting 4 win would throw away the url and silently
// downgrade a connector back to a name-only entry.
export function discoverMcpServers(cwd: string): DiscoveredMcpServer[] {
  const all = [
    ...projectServers(cwd),
    ...userAndLocalScopeServers(cwd),
    ...desktopConnectorServers(),
    ...claudeAiConnectorServers(),
    ...enabledBuiltinServers(),
  ];
  const seen = new Set<string>();
  const result: DiscoveredMcpServer[] = [];
  for (const entry of all) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    result.push(entry);
  }
  return result;
}
