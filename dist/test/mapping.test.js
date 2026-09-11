"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_test_1 = require("node:test");
const mapping_1 = require("../src/mapping");
// A minimal fake git repo (just needs a `.git` entry to exist) so tests can
// exercise the repo-relative "portable id" path, not just the raw-absolute
// fallback the other tests hit because their fake "/repo" cwd isn't a real repo.
function withFakeRepo(repoName, fn) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-test-'));
    const repoRoot = path.join(tmpRoot, repoName);
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, '.git'));
    fs.writeFileSync(path.join(repoRoot, 'src', 'foo.ts'), '// fixture');
    try {
        fn(repoRoot);
    }
    finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}
(0, node_test_1.test)('Bash maps to executeBash, falls back to cwd Directory with no clear target', () => {
    const m = (0, mapping_1.mapToolToCedar)('Bash', { command: 'npm install' }, '/repo');
    strict_1.default.equal(m.actionName, 'executeBash');
    strict_1.default.equal(m.resourceType, 'Directory');
    strict_1.default.equal(m.resourceId, '/repo');
    strict_1.default.equal(m.command, 'npm install');
    // Directory.path is required by the schema
    strict_1.default.equal(m.resourceProperties?.path, '/repo');
    // no repo context (fake /repo isn't a real git repo) — no ancestor chain
    // to report for an absolute-path fallback
    strict_1.default.deepEqual(m.resourceParents, []);
});
(0, node_test_1.test)('Bash extracts a file-looking target when present, resolved to an absolute path', () => {
    const m = (0, mapping_1.mapToolToCedar)('Bash', { command: 'cat src/index.ts' }, '/repo');
    strict_1.default.equal(m.resourceType, 'File');
    // Folder/file-scoped policies need a consistent absolute id regardless of
    // which tool produced it — a relative bash arg must resolve against cwd.
    strict_1.default.equal(m.resourceId, '/repo/src/index.ts');
    // File.name is required by the schema
    strict_1.default.equal(m.resourceProperties?.name, 'index.ts');
});
(0, node_test_1.test)('Bash with an already-absolute target leaves it unchanged', () => {
    const m = (0, mapping_1.mapToolToCedar)('Bash', { command: 'cat /etc/hosts' }, '/repo');
    strict_1.default.equal(m.resourceType, 'File');
    strict_1.default.equal(m.resourceId, '/etc/hosts');
});
(0, node_test_1.test)('Bash target starting with "~" expands to the real home directory, not a literal "~" subfolder', () => {
    const m = (0, mapping_1.mapToolToCedar)('Bash', { command: 'touch ~/Desktop/temp-file.txt' }, '/repo');
    const home = os.homedir();
    strict_1.default.equal(m.resourceId, `${home}/Desktop/temp-file.txt`);
    // must never look like it's nested inside the repo cwd
    strict_1.default.ok(!m.resourceId.startsWith('/repo'));
    // outside any repo — no bogus Repository ancestor
    strict_1.default.deepEqual(m.resourceParents, []);
});
(0, node_test_1.test)('inside a real repo, a bash "~" target does not get falsely attributed a Repository ancestor', () => {
    withFakeRepo('domain-services', (repoRoot) => {
        const m = (0, mapping_1.mapToolToCedar)('Bash', { command: 'rm ~/Desktop/temp-file.txt' }, repoRoot);
        const home = os.homedir();
        strict_1.default.equal(m.resourceId, `${home}/Desktop/temp-file.txt`);
        strict_1.default.ok(!m.resourceId.startsWith(repoRoot));
        strict_1.default.ok(!m.resourceId.includes('domain-services'));
        strict_1.default.deepEqual(m.resourceParents, []);
    });
});
(0, node_test_1.test)('Edit maps to its own edit action, File resource, tool name in context data', () => {
    const m = (0, mapping_1.mapToolToCedar)('Edit', { file_path: '/repo/src/config.ts' }, '/repo');
    strict_1.default.equal(m.actionName, 'edit');
    strict_1.default.equal(m.resourceType, 'File');
    strict_1.default.equal(m.resourceId, '/repo/src/config.ts');
    strict_1.default.equal(m.tool, 'Edit');
    strict_1.default.equal(m.command, undefined);
    strict_1.default.equal(m.resourceProperties?.name, 'config.ts');
    strict_1.default.equal(m.resourceProperties?.extension, 'ts');
});
(0, node_test_1.test)('MultiEdit and NotebookEdit fold into the same edit action as Edit', () => {
    const multi = (0, mapping_1.mapToolToCedar)('MultiEdit', { file_path: '/repo/src/config.ts' }, '/repo');
    strict_1.default.equal(multi.actionName, 'edit');
    strict_1.default.equal(multi.tool, 'MultiEdit');
    const notebook = (0, mapping_1.mapToolToCedar)('NotebookEdit', { file_path: '/repo/notebook.ipynb' }, '/repo');
    strict_1.default.equal(notebook.actionName, 'edit');
    strict_1.default.equal(notebook.tool, 'NotebookEdit');
});
(0, node_test_1.test)('Write maps to its own write action', () => {
    const m = (0, mapping_1.mapToolToCedar)('Write', { file_path: '/repo/src/new.ts' }, '/repo');
    strict_1.default.equal(m.actionName, 'write');
    strict_1.default.equal(m.resourceType, 'File');
    strict_1.default.equal(m.tool, 'Write');
});
(0, node_test_1.test)('Read maps to its own read action, File resource', () => {
    const m = (0, mapping_1.mapToolToCedar)('Read', { file_path: '/repo/README.md' }, '/repo');
    strict_1.default.equal(m.actionName, 'read');
    strict_1.default.equal(m.resourceType, 'File');
    strict_1.default.equal(m.tool, 'Read');
});
(0, node_test_1.test)('Glob maps to its own glob action, always Directory (never File)', () => {
    const m = (0, mapping_1.mapToolToCedar)('Glob', { pattern: 'src/**/*.ts' }, '/repo');
    strict_1.default.equal(m.actionName, 'glob');
    strict_1.default.equal(m.resourceType, 'Directory');
    strict_1.default.equal(m.resourceId, '/repo/src');
    strict_1.default.equal(m.pattern, 'src/**/*.ts');
    strict_1.default.equal(m.command, undefined);
});
(0, node_test_1.test)('Glob with a leading wildcard has no literal prefix, falls back to cwd', () => {
    const m = (0, mapping_1.mapToolToCedar)('Glob', { pattern: '**/*.md' }, '/repo');
    strict_1.default.equal(m.resourceType, 'Directory');
    // No literal directory segment before the wildcard — the safe bound is cwd itself.
    strict_1.default.equal(m.resourceId, '/repo');
});
(0, node_test_1.test)('Grep maps to its own grep action, Directory when path is a directory', () => {
    const m = (0, mapping_1.mapToolToCedar)('Grep', { pattern: 'TODO', path: 'src' }, '/repo');
    strict_1.default.equal(m.actionName, 'grep');
    strict_1.default.equal(m.resourceType, 'Directory');
    strict_1.default.equal(m.resourceId, '/repo/src');
    strict_1.default.equal(m.pattern, 'TODO');
});
(0, node_test_1.test)('Grep maps to File when path looks like a file (unlike Glob, which is Directory-only)', () => {
    const m = (0, mapping_1.mapToolToCedar)('Grep', { pattern: 'TODO', path: 'src/index.ts' }, '/repo');
    strict_1.default.equal(m.actionName, 'grep');
    strict_1.default.equal(m.resourceType, 'File');
    strict_1.default.equal(m.resourceId, '/repo/src/index.ts');
});
(0, node_test_1.test)('Task maps to spawn/SubAgent', () => {
    const m = (0, mapping_1.mapToolToCedar)('Task', { subagent_type: 'Explore' }, '/repo');
    strict_1.default.equal(m.actionName, 'spawn');
    strict_1.default.equal(m.resourceType, 'SubAgent');
    strict_1.default.equal(m.resourceId, 'Explore');
});
(0, node_test_1.test)('Agent (the real tool_name used by live Claude Code) also maps to spawn/SubAgent', () => {
    const m = (0, mapping_1.mapToolToCedar)('Agent', { subagent_type: 'Explore' }, '/repo');
    strict_1.default.equal(m.actionName, 'spawn');
    strict_1.default.equal(m.resourceType, 'SubAgent');
    strict_1.default.equal(m.resourceId, 'Explore');
});
(0, node_test_1.test)('MCP tool maps to invokeTool/Tool with an MCPServer parent', () => {
    const m = (0, mapping_1.mapToolToCedar)('mcp__github__search_repositories', { query: 'anthropic' }, '/repo');
    strict_1.default.equal(m.actionName, 'invokeTool');
    strict_1.default.equal(m.resourceType, 'Tool');
    strict_1.default.equal(m.resourceId, 'github/search_repositories');
    strict_1.default.deepEqual(m.resourceParents, [{ type: 'MCPServer', id: 'github' }]);
    // name/description are required on Tool
    strict_1.default.equal(m.resourceProperties?.name, 'search_repositories');
    strict_1.default.ok(m.resourceProperties?.description);
});
(0, node_test_1.test)('WebFetch maps to invokeTool generic fallback', () => {
    const m = (0, mapping_1.mapToolToCedar)('WebFetch', { url: 'https://example.com' }, '/repo');
    strict_1.default.equal(m.actionName, 'invokeTool');
    strict_1.default.equal(m.resourceType, 'Tool');
    strict_1.default.equal(m.resourceId, 'WebFetch');
    strict_1.default.ok(m.resourceProperties?.description);
});
(0, node_test_1.test)('unknown/future tool falls back to invokeTool, never silently skipped', () => {
    const m = (0, mapping_1.mapToolToCedar)('SomeFutureTool', {}, '/repo');
    strict_1.default.equal(m.actionName, 'invokeTool');
    strict_1.default.equal(m.resourceId, 'SomeFutureTool');
});
(0, node_test_1.test)('inside a real repo, Edit resolves to a portable "repoName/relative/path" id, not an absolute one', () => {
    withFakeRepo('domain-services', (repoRoot) => {
        const filePath = path.join(repoRoot, 'src', 'foo.ts');
        const m = (0, mapping_1.mapToolToCedar)('Edit', { file_path: filePath }, repoRoot);
        strict_1.default.equal(m.resourceId, 'domain-services/src/foo.ts');
        // absolute machine path must not leak into properties either
        strict_1.default.equal(m.resourceProperties?.name, 'foo.ts');
        // ancestor chain: immediate parent dir, repo-root dir, then the Repository itself
        strict_1.default.deepEqual(m.resourceParents, [
            { type: 'Directory', id: 'domain-services/src' },
            { type: 'Directory', id: 'domain-services' },
            { type: 'Repository', id: 'domain-services' },
        ]);
    });
});
(0, node_test_1.test)('a deeply nested file gets the COMPLETE ancestor chain, every level, no skipping', () => {
    withFakeRepo('domain-services', (repoRoot) => {
        const deepDir = path.join(repoRoot, 'src', 'main', 'java', 'com', 'foo');
        fs.mkdirSync(deepDir, { recursive: true });
        const filePath = path.join(deepDir, 'Bar.java');
        fs.writeFileSync(filePath, '// fixture');
        const m = (0, mapping_1.mapToolToCedar)('Read', { file_path: filePath }, repoRoot);
        strict_1.default.equal(m.resourceId, 'domain-services/src/main/java/com/foo/Bar.java');
        strict_1.default.deepEqual(m.resourceParents, [
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
(0, node_test_1.test)('inside a real repo, a relative Bash target resolves to the same portable id', () => {
    withFakeRepo('domain-services', (repoRoot) => {
        const m = (0, mapping_1.mapToolToCedar)('Bash', { command: 'cat src/foo.ts' }, repoRoot);
        strict_1.default.equal(m.resourceId, 'domain-services/src/foo.ts');
    });
});
(0, node_test_1.test)('inside a real repo, Bash with no clear target resolves to just the repo name, no self-referential parent', () => {
    withFakeRepo('domain-services', (repoRoot) => {
        const m = (0, mapping_1.mapToolToCedar)('Bash', { command: 'npm install' }, repoRoot);
        strict_1.default.equal(m.resourceType, 'Directory');
        strict_1.default.equal(m.resourceId, 'domain-services');
        // only the Repository — must NOT list "Directory: domain-services" as
        // its own parent
        strict_1.default.deepEqual(m.resourceParents, [{ type: 'Repository', id: 'domain-services' }]);
    });
});
(0, node_test_1.test)('inside a real repo, a path outside the repo falls back to the absolute path with no ancestor chain', () => {
    withFakeRepo('domain-services', (repoRoot) => {
        const m = (0, mapping_1.mapToolToCedar)('Bash', { command: 'cat /etc/hosts' }, repoRoot);
        strict_1.default.equal(m.resourceId, '/etc/hosts');
        strict_1.default.deepEqual(m.resourceParents, []);
    });
});
