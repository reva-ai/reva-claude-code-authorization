import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// One identifier for an MCP server, shared by discovery (mcpDiscovery.ts)
// and enforcement (mapping.ts). Before this module the two sides named the
// same server differently and could never join: discovery ingested
// "claude.ai Gmail" from ~/.claude.json's claudeAiMcpEverConnected, while
// every actual tool call arrives as mcp__d521f7ee-ac86-4efe-a02a-2f155cd06858__
// <tool> and was recorded under that raw uuid. A Cedar policy written
// against one could never match the other, and the MCPServer parent emitted
// at invoke time referenced an entity discovery had never ingested.
//
// The canonical id is a slug derived from the server's DISPLAY name —
// "Google Calendar" -> google-calendar, "claude.ai Gmail" -> gmail. Both
// sides converge on it: discovery slugifies the names it reads from disk,
// and enforcement resolves the uuid in the tool name back to a display name
// first (see below), then slugifies that same way.
//
// Slugging applies to EVERYTHING — display names and machine tokens alike.
// A .mcp.json key, an enabledMcpServers entry and the non-uuid half of an
// mcp__<server>__<tool> name all go through the same function, so one id
// format holds across every source: claude-browser, claude-in-chrome,
// claude-code-ios-simulator, computer-use, gmail. Both sides apply it, so
// they still agree.
//
// The cost, accepted on purpose: slugify is many-to-one, so "my_server" and
// "my-server" in one .mcp.json collapse to a single id and de-duplicate into
// one entity. Symmetric (enforcement collapses them identically, so nothing
// is orphaned), and the price of a predictable format everywhere.
//
// Why not the uuid itself, even though it IS stable — live-confirmed the
// same connector carries the same uuid across two different accounts on this
// machine (Claude Docs = 1a59c906-…, visualize = 6f616b42-… under both), so
// it's Anthropic's global connector id, not a per-install artifact: it's
// opaque. Nobody writes or reads a governance policy against
// d521f7ee-ac86-4efe-a02a-2f155cd06858, and it can't be reconciled against a
// connector directory. It's kept as an attribute for exactly that
// cross-referencing, just not as the key.
//
// Why not the url — a connector's url doesn't slugify to anything a human
// recognizes (gmailmcp.googleapis.com, calendarmcp.googleapis.com), and two
// servers can share a host. It's kept as an attribute too.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only the two prefixes confirmed to exist in real data are stripped —
// "claude.ai Gmail" (claudeAiMcpEverConnected) and "claude_ai_Gmail" (an
// older tool-name form). Deliberately not a looser /claude.?ai/ pattern: a
// server genuinely named something like "claude-ai-proxy" is a real name,
// not a prefixed one, and shouldn't be silently truncated.
const CLAUDE_AI_PREFIX = /^claude\.ai\s+|^claude_ai_/i;

export interface McpServerIdentity {
  // The canonical id — what both MCPServer entity ids and Cedar policies use.
  slug: string;
  // Human-readable name, when one is known. Absent for a bare uuid that
  // isn't in the cache yet.
  displayName?: string;
  // Present for a claude.ai connector (from remoteMcpServersConfig) —
  // absent for stdio/local servers and enabled built-in capabilities.
  url?: string;
  // Anthropic's global connector id, when this identity came from one.
  uuid?: string;
}

export interface DesktopConnector {
  uuid: string;
  name: string;
  url?: string;
}

export function slugifyMcpServerName(raw: string): string {
  if (typeof raw !== 'string') return '';
  const stripped = raw.replace(CLAUDE_AI_PREFIX, '');
  // A name that is ENTIRELY the prefix ("claude.ai ") would strip to nothing
  // — keep the original in that case rather than returning an empty id.
  const base = stripped.trim().length > 0 ? stripped : raw;
  return base
    .toLowerCase()
    .replace(/[\s._]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isMcpServerUuid(token: string): boolean {
  return typeof token === 'string' && UUID_PATTERN.test(token);
}

function claudeSessionsDir(): string {
  return process.env.REVA_CLAUDE_SESSIONS_DIR?.length
    ? process.env.REVA_CLAUDE_SESSIONS_DIR
    : path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
}

// The desktop app writes one file per session at
// <sessions>/<account>/<org>/local_<desktopSessionId>.json. Note the filename
// is the DESKTOP session id, not the session_id a hook receives — that one
// is the file's own cliSessionId field — so a hook can't construct the path
// for its own session and has to scan. Hence the newest-first cap below:
// this is never worth an unbounded scan, and the cache it feeds is merged
// rather than replaced, so a connector seen once survives falling out of the
// window.
function desktopSessionFiles(limit: number): string[] {
  const base = claudeSessionsDir();
  const found: { file: string; mtimeMs: number }[] = [];
  let accounts: string[];
  try {
    accounts = fs.readdirSync(base);
  } catch {
    return [];
  }
  for (const account of accounts) {
    let orgs: string[];
    try {
      orgs = fs.readdirSync(path.join(base, account));
    } catch {
      continue;
    }
    for (const org of orgs) {
      const dir = path.join(base, account, org);
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.startsWith('local_') || !name.endsWith('.json')) continue;
        const file = path.join(dir, name);
        try {
          found.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
        } catch {
          // unreadable entry contributes nothing, same as everywhere else here
        }
      }
    }
  }
  return found
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
    .map((entry) => entry.file);
}

// Every claude.ai connector currently configured for this machine, with the
// uuid that appears in tool names, its display name, and its real url.
// Best-effort and fault-tolerant throughout: a missing directory (any
// non-macOS host, or a CLI-only install) just yields nothing, never an error.
//
// These files are ~0.5-1 MB each because they embed full tool schemas, so
// this is deliberately NOT called from the PreToolUse path — only from the
// detached ingestMcpServers child, which writes the small cache that the
// hot path reads instead.
export function readDesktopConnectors(limit = 20): DesktopConnector[] {
  const byUuid = new Map<string, DesktopConnector>();
  for (const file of desktopSessionFiles(limit)) {
    let data: any;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const configured = data?.remoteMcpServersConfig;
    if (!Array.isArray(configured)) continue;
    for (const entry of configured) {
      const uuid = entry?.uuid;
      const name = entry?.name;
      if (typeof uuid !== 'string' || !uuid.length) continue;
      if (typeof name !== 'string' || !name.length) continue;
      // Newest file wins — files are already sorted newest-first, so the
      // first spelling seen for a uuid is the most recent one.
      if (byUuid.has(uuid)) continue;
      byUuid.set(uuid, { uuid, name, url: typeof entry?.url === 'string' ? entry.url : undefined });
    }
  }
  return [...byUuid.values()];
}

function identityCachePath(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'mcp-server-identity.json') : undefined;
}

export function loadMcpServerIdentityCache(pluginDataDir?: string): Record<string, McpServerIdentity> {
  const file = identityCachePath(pluginDataDir);
  if (!file) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Rebuilds the uuid -> identity map the PreToolUse path reads. MERGED into
// whatever is already cached rather than replacing it: a connector that has
// been disconnected, or whose session file has aged out of the newest-N
// window, should keep resolving to its real name rather than silently
// reverting to a raw uuid in the audit trail.
export function refreshMcpServerIdentityCache(pluginDataDir?: string): Record<string, McpServerIdentity> {
  const merged = loadMcpServerIdentityCache(pluginDataDir);
  for (const connector of readDesktopConnectors()) {
    // Keyed lowercase so a lookup can normalize to match — see
    // resolveMcpServerIdentity.
    merged[connector.uuid.toLowerCase()] = {
      slug: slugifyMcpServerName(connector.name),
      displayName: connector.name,
      url: connector.url,
      uuid: connector.uuid,
    };
  }
  const file = identityCachePath(pluginDataDir);
  if (file && pluginDataDir) {
    try {
      fs.mkdirSync(pluginDataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(merged, null, 2), 'utf8');
    } catch {
      // best effort — a cache that can't be written just means the next
      // resolve falls back to the raw token, never a failed hook
    }
  }
  return merged;
}

// Invoke-time resolution of the server token in an mcp__<server>__<tool>
// name. A uuid is looked up in the cache written by the detached ingestion
// child; anything else is slugified directly.
//
// On a cache MISS the raw token is returned unchanged — deliberately never a
// fabricated slug. A uuid carries no name, so there is nothing honest to
// derive from it, and emitting a guessed id into an audit trail is worse
// than emitting an opaque-but-true one. The miss is self-healing: the next
// discovery pass caches that uuid, and ingest-on-invoke triggers one
// immediately (see authorize.ts), so it converges within one pass.
export function resolveMcpServerIdentity(token: string, pluginDataDir?: string): McpServerIdentity {
  if (!isMcpServerUuid(token)) {
    // Slugged, like everything else. ONE id format across every source and
    // every tool name — Claude_Browser -> claude-browser,
    // Claude_Code_iOS_Simulator -> claude-code-ios-simulator,
    // plugin_context7_context7 -> plugin-context7-context7. Discovery applies
    // the identical function to the keys it reads, so the two sides still
    // agree; the difference from before is only that the shared id is now
    // uniform rather than whatever casing the source happened to use.
    //
    // Known cost, accepted deliberately: slugify is many-to-one, so two
    // genuinely different entries in one .mcp.json — "my_server" and
    // "my-server" — collapse onto a single id and de-duplicate into one
    // entity. That is a real loss, but it is symmetric (enforcement collapses
    // them the same way, so nothing is orphaned) and it buys an id format
    // that is predictable everywhere.
    return { slug: slugifyMcpServerName(token) || token };
  }
  // isMcpServerUuid accepts either case, so normalize before both the lookup
  // and the fallback. Without this an uppercase spelling misses the
  // (lowercase-keyed) cache AND falls back to the raw uppercase string,
  // landing one connector under two different entity ids — the exact split
  // identity this module exists to prevent. Every tool name observed in the
  // wild is lowercase, so this is a guard, not a fix for something seen.
  const uuid = token.toLowerCase();
  const cached = loadMcpServerIdentityCache(pluginDataDir)[uuid];
  if (cached && typeof cached.slug === 'string' && cached.slug.length > 0) return cached;
  return { slug: uuid, uuid };
}
