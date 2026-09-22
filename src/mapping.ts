import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveMcpServerIdentity } from './mcpServerIdentity';
import { CedarActionMapping, CedarEntityRef } from './types';

// MultiEdit and NotebookEdit are the same mutation semantics as Edit (batched,
// or notebook-specific) — grouped under the single "edit" action rather than
// getting one action each; the original tool name still rides in context.tool.
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);

// Fallback only — an extension-based guess misclassifies real extensionless
// files (/etc/hosts, Makefile, Dockerfile) as directories. Used only when the
// path doesn't exist on disk yet (e.g. a file Write is about to create).
function looksLikeFile(pathValue: string): boolean {
  const base = pathValue.replace(/\\/g, '/').split('/').pop() || '';
  return base.includes('.') && !base.startsWith('.');
}

// The hook runs on the same machine as the actual repo, so prefer a real
// stat over guessing from the path string whenever the path already exists.
function classifyPath(absolutePath: string): 'File' | 'Directory' {
  try {
    return fs.statSync(absolutePath).isDirectory() ? 'Directory' : 'File';
  } catch {
    return looksLikeFile(absolutePath) ? 'File' : 'Directory';
  }
}

// Directory portion of a glob pattern, stopping at the first wildcard
// segment — a Cedar policy on a literal folder path can never match a
// resource id that still contains "**" or "*" as a path segment.
function literalDirOf(patternValue: string): string {
  const segments = patternValue.replace(/\\/g, '/').split('/');
  const literal: string[] = [];
  for (const seg of segments) {
    if (/[*?{}[\]]/.test(seg)) break;
    literal.push(seg);
  }
  // If nothing was a wildcard, the last segment is the filename itself, not
  // a directory — drop it so we return the containing directory.
  if (literal.length === segments.length && literal.length > 0) {
    literal.pop();
  }
  return literal.join('/') || '.';
}

// path.resolve does NOT do shell-style "~" expansion — it treats "~" as a
// literal folder name. Without this, a bash command like
// "touch ~/Desktop/file.txt" resolves against cwd as if "~" were a real
// subdirectory *inside* the repo (e.g. "domain-services/~/Desktop/file.txt"),
// which then incorrectly gets a Repository ancestor for a file that isn't
// in the repo at all — a real policy bypass, not just a cosmetic bug.
// Only handles the current user's home ("~" or "~/..."); "~otheruser/..."
// is left unexpanded (rare in practice, and Node has no simple builtin for
// resolving another user's home directory).
function expandHome(pathValue: string): string {
  if (pathValue === '~') return os.homedir();
  if (pathValue.startsWith('~/')) return path.join(os.homedir(), pathValue.slice(2));
  return pathValue;
}

function resolveAgainst(cwd: string, pathValue: string): string {
  return path.resolve(cwd, expandHome(pathValue));
}

// Walks up from cwd looking for a `.git` entry to find the repo root.
function findRepoRoot(startDir: string): string | undefined {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Cedar policies are authored once against a portable id like
// "domain-services/utility/agents.md" so the same policy applies no matter
// whose machine or home directory the repo is cloned into — an absolute
// path like "/Users/alice/repos/domain-services/..." is specific to one
// person's machine and could never be referenced from a policy meant to
// apply to every developer with this plugin installed. Falls back to
// the raw absolute path only when no git repo root can be found, or the
// path falls outside it entirely.
function toPortableId(absolutePath: string, cwd: string): string {
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return absolutePath;
  const repoName = path.basename(repoRoot);
  const rel = path.relative(repoRoot, absolutePath);
  if (rel === '') return repoName;
  if (rel.startsWith('..')) return absolutePath;
  return `${repoName}/${rel.split(path.sep).join('/')}`;
}

function baseName(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').split('/').pop() || pathValue;
}

function extension(pathValue: string): string | undefined {
  const base = baseName(pathValue);
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx + 1) : undefined;
}

// File/Directory entities declare `name`/`path` as required attributes in
// the CodingAgent schema — these helpers keep that consistent everywhere a
// File or Directory resource gets built. Operate on the portable id, same
// as resourceId, so nothing machine-specific leaks into these either.
function fileProperties(portableId: string): Record<string, any> {
  const ext = extension(portableId);
  return { name: baseName(portableId), ...(ext ? { extension: ext } : {}) };
}

function directoryProperties(portableId: string): Record<string, any> {
  return { path: portableId };
}

// The RTG expects a FLAT list of every ancestor, not just the immediate
// parent — Cedar's `in` needs the whole chain present to match a policy
// like `resource in Directory::"domain-services"` regardless of how deep
// the file actually is. No ancestor chain for the absolute-path fallback
// (outside any repo) — there's no meaningful Directory/Repository lineage
// to report for those.
function buildAncestorParents(portableId: string): CedarEntityRef[] {
  // path.isAbsolute (not a bare '/' check) so the fallback is recognized on
  // Windows too, where toPortableId()'s absolute-path fallback returns a
  // raw "C:\Users\..." path rather than a POSIX-style one.
  if (path.isAbsolute(portableId)) return [];
  const segments = portableId.split('/');
  const repoName = segments[0];
  if (!repoName) return [];
  const parents: CedarEntityRef[] = [];
  for (let i = segments.length - 1; i > 1; i--) {
    parents.push({ type: 'Directory', id: segments.slice(0, i).join('/') });
  }
  if (segments.length > 1) {
    parents.push({ type: 'Directory', id: repoName });
  }
  parents.push({ type: 'Repository', id: repoName });
  return parents;
}

// Best-effort extraction of a bash command's primary file/dir argument, for
// a more specific resource than bare cwd. Deliberately conservative: shell
// commands are too varied to parse reliably, so anything ambiguous (pipes,
// substitutions, flags-only) just falls back to the working directory.
function extractBashTarget(command: string, cwd: string): { type: 'File' | 'Directory'; absolutePath: string } {
  const tokens = command.trim().split(/\s+/).slice(1);
  const candidate = tokens.find(
    (t) => t.length > 0 && !t.startsWith('-') && !t.startsWith('$') && !t.startsWith('`') && (t.includes('/') || t.includes('.')),
  );
  if (candidate) {
    const resolved = resolveAgainst(cwd, candidate);
    return { type: classifyPath(resolved), absolutePath: resolved };
  }
  return { type: 'Directory', absolutePath: cwd };
}

export function mapToolToCedar(toolName: string, toolInput: Record<string, any>, cwd: string): CedarActionMapping {
  if (toolName === 'Bash') {
    const command: string = toolInput.command || '';
    const target = extractBashTarget(command, cwd);
    const id = toPortableId(target.absolutePath, cwd);
    return {
      actionName: 'executeBash',
      resourceType: target.type,
      resourceId: id,
      resourceProperties: target.type === 'File' ? fileProperties(id) : directoryProperties(id),
      resourceParents: buildAncestorParents(id),
      command,
    };
  }

  if (toolName === 'Read') {
    const absolutePath = resolveAgainst(cwd, toolInput.file_path || toolInput.path || cwd);
    const id = toPortableId(absolutePath, cwd);
    return {
      actionName: 'read',
      resourceType: 'File',
      resourceId: id,
      resourceProperties: fileProperties(id),
      resourceParents: buildAncestorParents(id),
      tool: toolName,
    };
  }

  if (toolName === 'Write') {
    const absolutePath = resolveAgainst(cwd, toolInput.file_path || toolInput.path || cwd);
    const id = toPortableId(absolutePath, cwd);
    return {
      actionName: 'write',
      resourceType: 'File',
      resourceId: id,
      resourceProperties: fileProperties(id),
      resourceParents: buildAncestorParents(id),
      tool: toolName,
    };
  }

  if (EDIT_TOOLS.has(toolName)) {
    const absolutePath = resolveAgainst(cwd, toolInput.file_path || toolInput.path || cwd);
    const id = toPortableId(absolutePath, cwd);
    return {
      actionName: 'edit',
      resourceType: 'File',
      resourceId: id,
      resourceProperties: fileProperties(id),
      resourceParents: buildAncestorParents(id),
      tool: toolName,
    };
  }

  if (toolName === 'Glob') {
    // Glob only ever searches within a directory — it never targets a
    // single file — so its resource is always a Directory, unlike Grep.
    const pattern: string = toolInput.pattern || '';
    const absoluteDir = resolveAgainst(cwd, toolInput.path || literalDirOf(pattern) || cwd);
    const id = toPortableId(absoluteDir, cwd);
    return {
      actionName: 'glob',
      resourceType: 'Directory',
      resourceId: id,
      resourceProperties: directoryProperties(id),
      resourceParents: buildAncestorParents(id),
      pattern,
      tool: toolName,
    };
  }

  if (toolName === 'Grep') {
    // Unlike Glob, Grep can target either a specific file or a directory
    // tree depending on tool_input.path.
    const pattern: string = toolInput.pattern || '';
    const absoluteTarget = resolveAgainst(cwd, toolInput.path || cwd);
    const type = classifyPath(absoluteTarget);
    const id = toPortableId(absoluteTarget, cwd);
    return {
      actionName: 'grep',
      resourceType: type,
      resourceId: id,
      resourceProperties: type === 'File' ? fileProperties(id) : directoryProperties(id),
      resourceParents: buildAncestorParents(id),
      pattern,
      tool: toolName,
    };
  }

  // "Agent" is the real tool_name Claude Code uses to launch a subagent
  // (confirmed via live testing) — "Task" is kept too since it's what the
  // docs describe and it costs nothing to also match it.
  if (toolName === 'Agent' || toolName === 'Task') {
    const subagentType: string = toolInput.subagent_type || toolInput.subagentType || toolInput.agent_type || 'subagent';
    return {
      actionName: 'spawn',
      resourceType: 'SubAgent',
      resourceId: subagentType,
      resourceProperties: { agentType: subagentType },
    };
  }

  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const token = parts[1] || 'unknown-server';
    const tool = parts.slice(2).join('__') || toolName;

    // The token here is whatever Claude Code embeds in the tool name, which
    // for a claude.ai connector in the desktop app is a bare uuid
    // (mcp__d521f7ee-…__search_threads — live-confirmed by invoking Gmail).
    // Resolve it to the same slug discovery ingests, so the MCPServer parent
    // below points at an entity that actually exists. Fully fault-tolerant
    // inside (see mcpServerIdentity.ts): this runs on the PreToolUse path,
    // where authorize.ts fails CLOSED, so a cache miss or an unreadable
    // cache must degrade to the raw token and never throw.
    const server = resolveMcpServerIdentity(token, process.env.CLAUDE_PLUGIN_DATA);
    const label = server.displayName || server.slug;
    return {
      actionName: 'invokeTool',
      resourceType: 'Tool',
      resourceId: `${server.slug}/${tool}`,
      // name/description are required on Tool; Claude Code's hook input
      // doesn't give us a real description, so this is synthesized.
      resourceProperties: { name: tool, description: `MCP tool "${tool}" on server "${label}"`, connectionType: 'mcp' },
      resourceParents: [{ type: 'MCPServer', id: server.slug }],
    };
  }

  // WebFetch, WebSearch, and any other/unrecognized built-in tool — safe
  // generic fallback so nothing is silently skipped.
  return {
    actionName: 'invokeTool',
    resourceType: 'Tool',
    resourceId: toolName,
    resourceProperties: { name: toolName, description: `Claude Code built-in tool: ${toolName}` },
  };
}
