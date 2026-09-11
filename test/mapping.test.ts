import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { mapToolToCedar } from '../src/mapping';

// A minimal fake git repo (just needs a `.git` entry to exist) so tests can
// exercise the repo-relative "portable id" path, not just the raw-absolute
// fallback the other tests hit because their fake "/repo" cwd isn't a real repo.
function withFakeRepo(repoName: string, fn: (repoRoot: string) => void): void {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-test-'));
  const repoRoot = path.join(tmpRoot, repoName);
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.git'));
  fs.writeFileSync(path.join(repoRoot, 'src', 'foo.ts'), '// fixture');
  try {
    fn(repoRoot);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

test('Bash maps to executeBash, falls back to cwd Directory with no clear target', () => {
  const m = mapToolToCedar('Bash', { command: 'npm install' }, '/repo');
  assert.equal(m.actionName, 'executeBash');
  assert.equal(m.resourceType, 'Directory');
  assert.equal(m.resourceId, '/repo');
  assert.equal(m.command, 'npm install');
  // Directory.path is required by the schema
  assert.equal(m.resourceProperties?.path, '/repo');
  // no repo context (fake /repo isn't a real git repo) — no ancestor chain
  // to report for an absolute-path fallback
  assert.deepEqual(m.resourceParents, []);
});

test('Bash extracts a file-looking target when present, resolved to an absolute path', () => {
  const m = mapToolToCedar('Bash', { command: 'cat src/index.ts' }, '/repo');
  assert.equal(m.resourceType, 'File');
  // Folder/file-scoped policies need a consistent absolute id regardless of
  // which tool produced it — a relative bash arg must resolve against cwd.
  assert.equal(m.resourceId, '/repo/src/index.ts');
  // File.name is required by the schema
  assert.equal(m.resourceProperties?.name, 'index.ts');
});

test('Bash with an already-absolute target leaves it unchanged', () => {
  const m = mapToolToCedar('Bash', { command: 'cat /etc/hosts' }, '/repo');
  assert.equal(m.resourceType, 'File');
  assert.equal(m.resourceId, '/etc/hosts');
});

test('Bash target starting with "~" expands to the real home directory, not a literal "~" subfolder', () => {
  const m = mapToolToCedar('Bash', { command: 'touch ~/Desktop/temp-file.txt' }, '/repo');
  const home = os.homedir();
  assert.equal(m.resourceId, `${home}/Desktop/temp-file.txt`);
  // must never look like it's nested inside the repo cwd
  assert.ok(!m.resourceId.startsWith('/repo'));
  // outside any repo — no bogus Repository ancestor
  assert.deepEqual(m.resourceParents, []);
});

test('inside a real repo, a bash "~" target does not get falsely attributed a Repository ancestor', () => {
  withFakeRepo('domain-services', (repoRoot) => {
    const m = mapToolToCedar('Bash', { command: 'rm ~/Desktop/temp-file.txt' }, repoRoot);
    const home = os.homedir();
    assert.equal(m.resourceId, `${home}/Desktop/temp-file.txt`);
    assert.ok(!m.resourceId.startsWith(repoRoot));
    assert.ok(!m.resourceId.includes('domain-services'));
    assert.deepEqual(m.resourceParents, []);
  });
});

test('Edit maps to its own edit action, File resource, tool name in context data', () => {
  const m = mapToolToCedar('Edit', { file_path: '/repo/src/config.ts' }, '/repo');
  assert.equal(m.actionName, 'edit');
  assert.equal(m.resourceType, 'File');
  assert.equal(m.resourceId, '/repo/src/config.ts');
  assert.equal(m.tool, 'Edit');
  assert.equal(m.command, undefined);
  assert.equal(m.resourceProperties?.name, 'config.ts');
  assert.equal(m.resourceProperties?.extension, 'ts');
});

test('MultiEdit and NotebookEdit fold into the same edit action as Edit', () => {
  const multi = mapToolToCedar('MultiEdit', { file_path: '/repo/src/config.ts' }, '/repo');
  assert.equal(multi.actionName, 'edit');
  assert.equal(multi.tool, 'MultiEdit');

  const notebook = mapToolToCedar('NotebookEdit', { file_path: '/repo/notebook.ipynb' }, '/repo');
  assert.equal(notebook.actionName, 'edit');
  assert.equal(notebook.tool, 'NotebookEdit');
});

test('Write maps to its own write action', () => {
  const m = mapToolToCedar('Write', { file_path: '/repo/src/new.ts' }, '/repo');
  assert.equal(m.actionName, 'write');
  assert.equal(m.resourceType, 'File');
  assert.equal(m.tool, 'Write');
});

test('Read maps to its own read action, File resource', () => {
  const m = mapToolToCedar('Read', { file_path: '/repo/README.md' }, '/repo');
  assert.equal(m.actionName, 'read');
  assert.equal(m.resourceType, 'File');
  assert.equal(m.tool, 'Read');
});

test('Glob maps to its own glob action, always Directory (never File)', () => {
  const m = mapToolToCedar('Glob', { pattern: 'src/**/*.ts' }, '/repo');
  assert.equal(m.actionName, 'glob');
  assert.equal(m.resourceType, 'Directory');
  assert.equal(m.resourceId, '/repo/src');
  assert.equal(m.pattern, 'src/**/*.ts');
  assert.equal(m.command, undefined);
});

test('Glob with a leading wildcard has no literal prefix, falls back to cwd', () => {
  const m = mapToolToCedar('Glob', { pattern: '**/*.md' }, '/repo');
  assert.equal(m.resourceType, 'Directory');
  // No literal directory segment before the wildcard — the safe bound is cwd itself.
  assert.equal(m.resourceId, '/repo');
});

test('Grep maps to its own grep action, Directory when path is a directory', () => {
  const m = mapToolToCedar('Grep', { pattern: 'TODO', path: 'src' }, '/repo');
  assert.equal(m.actionName, 'grep');
  assert.equal(m.resourceType, 'Directory');
  assert.equal(m.resourceId, '/repo/src');
  assert.equal(m.pattern, 'TODO');
});

test('Grep maps to File when path looks like a file (unlike Glob, which is Directory-only)', () => {
  const m = mapToolToCedar('Grep', { pattern: 'TODO', path: 'src/index.ts' }, '/repo');
  assert.equal(m.actionName, 'grep');
  assert.equal(m.resourceType, 'File');
  assert.equal(m.resourceId, '/repo/src/index.ts');
});

test('Task maps to spawn/SubAgent', () => {
  const m = mapToolToCedar('Task', { subagent_type: 'Explore' }, '/repo');
  assert.equal(m.actionName, 'spawn');
  assert.equal(m.resourceType, 'SubAgent');
  assert.equal(m.resourceId, 'Explore');
});

test('Agent (the real tool_name used by live Claude Code) also maps to spawn/SubAgent', () => {
  const m = mapToolToCedar('Agent', { subagent_type: 'Explore' }, '/repo');
  assert.equal(m.actionName, 'spawn');
  assert.equal(m.resourceType, 'SubAgent');
  assert.equal(m.resourceId, 'Explore');
});

test('MCP tool maps to invokeTool/Tool with an MCPServer parent', () => {
  const m = mapToolToCedar('mcp__github__search_repositories', { query: 'anthropic' }, '/repo');
  assert.equal(m.actionName, 'invokeTool');
  assert.equal(m.resourceType, 'Tool');
  assert.equal(m.resourceId, 'github/search_repositories');
  assert.deepEqual(m.resourceParents, [{ type: 'MCPServer', id: 'github' }]);
  // name/description are required on Tool
  assert.equal(m.resourceProperties?.name, 'search_repositories');
  assert.ok(m.resourceProperties?.description);
});

test('WebFetch maps to invokeTool generic fallback', () => {
  const m = mapToolToCedar('WebFetch', { url: 'https://example.com' }, '/repo');
  assert.equal(m.actionName, 'invokeTool');
  assert.equal(m.resourceType, 'Tool');
  assert.equal(m.resourceId, 'WebFetch');
  assert.ok(m.resourceProperties?.description);
});

test('unknown/future tool falls back to invokeTool, never silently skipped', () => {
  const m = mapToolToCedar('SomeFutureTool', {}, '/repo');
  assert.equal(m.actionName, 'invokeTool');
  assert.equal(m.resourceId, 'SomeFutureTool');
});

test('inside a real repo, Edit resolves to a portable "repoName/relative/path" id, not an absolute one', () => {
  withFakeRepo('domain-services', (repoRoot) => {
    const filePath = path.join(repoRoot, 'src', 'foo.ts');
    const m = mapToolToCedar('Edit', { file_path: filePath }, repoRoot);
    assert.equal(m.resourceId, 'domain-services/src/foo.ts');
    // absolute machine path must not leak into properties either
    assert.equal(m.resourceProperties?.name, 'foo.ts');
    // ancestor chain: immediate parent dir, repo-root dir, then the Repository itself
    assert.deepEqual(m.resourceParents, [
      { type: 'Directory', id: 'domain-services/src' },
      { type: 'Directory', id: 'domain-services' },
      { type: 'Repository', id: 'domain-services' },
    ]);
  });
});

test('a deeply nested file gets the COMPLETE ancestor chain, every level, no skipping', () => {
  withFakeRepo('domain-services', (repoRoot) => {
    const deepDir = path.join(repoRoot, 'src', 'main', 'java', 'com', 'foo');
    fs.mkdirSync(deepDir, { recursive: true });
    const filePath = path.join(deepDir, 'Bar.java');
    fs.writeFileSync(filePath, '// fixture');
    const m = mapToolToCedar('Read', { file_path: filePath }, repoRoot);
    assert.equal(m.resourceId, 'domain-services/src/main/java/com/foo/Bar.java');
    assert.deepEqual(m.resourceParents, [
      { type: 'Directory', id: 'domain-services/src/main/java/com/foo' },
      { type: 'Directory', id: 'domain-services/src/main/java/com' },
      { type: 'Directory', id: 'domain-services/src/main/java' },
      { type: 'Directory', id: 'domain-services/src/main' },
      { type: 'Directory', id: 'domain-services/src' },
      { type: 'Directory', id: 'domain-services' },
      { type: 'Repository', id: 'domain-services' },
    ]);
  });
});

test('inside a real repo, a relative Bash target resolves to the same portable id', () => {
  withFakeRepo('domain-services', (repoRoot) => {
    const m = mapToolToCedar('Bash', { command: 'cat src/foo.ts' }, repoRoot);
    assert.equal(m.resourceId, 'domain-services/src/foo.ts');
  });
});

test('inside a real repo, Bash with no clear target resolves to just the repo name, no self-referential parent', () => {
  withFakeRepo('domain-services', (repoRoot) => {
    const m = mapToolToCedar('Bash', { command: 'npm install' }, repoRoot);
    assert.equal(m.resourceType, 'Directory');
    assert.equal(m.resourceId, 'domain-services');
    // only the Repository — must NOT list "Directory: domain-services" as
    // its own parent
    assert.deepEqual(m.resourceParents, [{ type: 'Repository', id: 'domain-services' }]);
  });
});

test('inside a real repo, a path outside the repo falls back to the absolute path with no ancestor chain', () => {
  withFakeRepo('domain-services', (repoRoot) => {
    const m = mapToolToCedar('Bash', { command: 'cat /etc/hosts' }, repoRoot);
    assert.equal(m.resourceId, '/etc/hosts');
    assert.deepEqual(m.resourceParents, []);
  });
});
