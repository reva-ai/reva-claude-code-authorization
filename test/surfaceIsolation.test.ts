import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, TestContext } from 'node:test';
import { markSessionActive } from '../src/activeSessions';

const PLUGIN_ROOT = path.resolve(__dirname, '../..');
const HOOKS = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'hooks/hooks.json'), 'utf8')).hooks;
const HOOK_NAMES = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const;
const AUTHORIZATION_HOOKS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const;
type HookName = (typeof HOOK_NAMES)[number];
const SESSION_ID = 'surface-isolation-session';
const AGENT_ID = 'surface-isolation-agent';

// Resolve the files actually shipped in hooks.json instead of maintaining a
// second list of entrypoint filenames that could stop testing the real hooks.
function hookPath(name: HookName): string {
  const commands = HOOKS[name].flatMap((group: { hooks: { command: string }[] }) => group.hooks);
  assert.equal(commands.length, 1, `${name} must have one command entrypoint`);
  const match = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"$/.exec(commands[0].command);
  assert.ok(match, `Unexpected hook command: ${commands[0].command}`);
  return path.join(PLUGIN_ROOT, match[1]);
}

interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runProcess(entrypoint: string, env: NodeJS.ProcessEnv, stdin: string | null): Promise<HookResult> {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: env.REVA_SESSION_CWD,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  // An excluded surface can exit before the parent finishes its write.
  child.stdin.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED') stderr += String(err);
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 5000);
  try {
    const completion = new Promise<HookResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
    // null deliberately leaves stdin open: a surface guard must run BEFORE
    // readStdin(), or a non-Code host can hang without ever sending a payload.
    if (stdin !== null) child.stdin.end(stdin);
    const result = await completion;
    assert.equal(timedOut, false, `Hook waited for stdin or a service: ${entrypoint}`);
    return result;
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
  }
}

function snapshot(root: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  function visit(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        result[relativePath] = 'directory';
        visit(fullPath);
      } else {
        result[relativePath] = {
          content: fs.readFileSync(fullPath).toString('base64'),
          mtimeMs: fs.statSync(fullPath).mtimeMs,
        };
      }
    }
  }
  visit(root);
  return result;
}

async function fixture(t: TestContext, repo = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-surface-isolation-'));
  const workspace = path.join(root, 'workspace');
  const dataDir = path.join(root, 'plugin-data');
  const homeDir = path.join(root, 'home');
  for (const dir of [workspace, dataDir, homeDir]) fs.mkdirSync(dir);
  if (repo) fs.mkdirSync(path.join(workspace, '.git'));
  // Seed the target session as well as an unrelated session so SessionEnd
  // cannot silently mutate an existing Code registry in a Cowork process.
  markSessionActive(AGENT_ID, SESSION_ID, 'cli', dataDir);
  markSessionActive(AGENT_ID, 'other-code-session', 'claude-vscode', dataDir);
  const requests: { url: string; body: string }[] = [];
  const response = { status: 403 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8').on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ url: req.url || '', body });
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ decision: response.status === 200, context: { reason: 'surface test policy' } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  // Never inherit the developer's credentials, runtime markers, HOME or
  // plugin configuration. Every possible request goes to this local server.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '',
    HOME: homeDir,
    USER: 'surface-test-user',
    REVA_AUTH_TOKEN: 'surface-test-token',
    REVA_AGENT_ID: AGENT_ID,
    REVA_HOST: `http://127.0.0.1:${address.port}`,
    REVA_PDP_TIMEOUT_MS: '1000',
    REVA_INGESTION_TIMEOUT_MS: '1000',
    REVA_CLAUDE_JSON_PATH: path.join(homeDir, '.claude.json'),
    REVA_SESSION_CWD: workspace,
    CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
    CLAUDE_PLUGIN_DATA: dataDir,
  };
  const input = (name: HookName, tool = 'Bash') => JSON.stringify({
    hook_event_name: name,
    session_id: SESSION_ID,
    cwd: workspace,
    source: 'startup',
    prompt: 'Help with this task',
    tool_name: tool,
    tool_input: { command: 'pwd' },
    tool_response: 'test response',
  });
  return { root, env, requests, response, input };
}

const COWORK_SURFACES: [string, NodeJS.ProcessEnv][] = [
  ['local-agent', { CLAUDE_CODE_ENTRYPOINT: 'local-agent' }],
  ['remote_cowork', { CLAUDE_CODE_ENTRYPOINT: 'remote_cowork' }],
  ['remote_cowork_trigger', { CLAUDE_CODE_ENTRYPOINT: 'remote_cowork_trigger' }],
  ['positive Cowork marker', { CLAUDE_CODE_IS_COWORK: '1' }],
];

test('every registered hook is inert in Cowork before parsing or waiting for input', async (t) => {
  assert.deepEqual(Object.keys(HOOKS).sort(), [...HOOK_NAMES].sort(), 'New hooks must be added to the isolation matrix');
  const f = await fixture(t, true);
  const before = snapshot(f.root);
  for (const [surface, marker] of COWORK_SURFACES) {
    for (const hook of HOOK_NAMES) {
      for (const [payloadName, payload] of [
        ['valid', f.input(hook)],
        ['malformed', '{not JSON'],
        ['open stdin', null],
      ] as const) {
        await t.test(`${surface}: ${hook}, ${payloadName}`, async () => {
          const result = await runProcess(hookPath(hook), { ...f.env, ...marker }, payload);
          assert.equal(result.code, 0, result.stderr);
          assert.equal(result.stdout, '');
          assert.equal(result.stderr, '');
          assert.deepEqual(f.requests, [], 'Cowork must not contact evaluation or ingestion services');
          assert.deepEqual(snapshot(f.root), before, 'Cowork must not change Code session or plugin state');
        });
      }
    }
  }
});

test('Chat/Cowork does not require Reva credentials and debug output never includes the payload', async (t) => {
  const f = await fixture(t);
  const before = snapshot(f.root);
  const env: NodeJS.ProcessEnv = { ...f.env, CLAUDE_CODE_ENTRYPOINT: 'local-agent', CLAUDE_CODE_IS_COWORK: '1', REVA_DEBUG: '1' };
  delete env.REVA_AUTH_TOKEN;
  delete env.REVA_AGENT_ID;
  for (const hook of HOOK_NAMES) {
    const result = await runProcess(hookPath(hook), env, f.input(hook));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '[reva-security] scope: skipping Chat/Cowork runtime; Claude Code authorization is not applicable\n');
  }
  assert.deepEqual(f.requests, []);
  // REVA_DEBUG=1 deliberately appends to CLAUDE_PLUGIN_DATA/debug.log even on
  // an excluded surface — see debug.ts: a hook run by the Desktop app has no
  // terminal whose stderr anyone can read, so the file is the only destination
  // guaranteed to be checkable afterward, which is exactly the Cowork case.
  // That opt-in diagnostic is therefore the one permitted addition here: Code
  // session and plugin state must still be untouched, and — the claim this
  // test's name actually makes — the log must carry none of the payload.
  const debugLogPath = path.join(f.root, 'plugin-data', 'debug.log');
  const debugLogKey = path.relative(f.root, debugLogPath);
  const after = snapshot(f.root);
  assert.ok(after[debugLogKey], 'REVA_DEBUG=1 must still record the skip where a Desktop-app run can be inspected');
  delete after[debugLogKey];
  assert.deepEqual(after, before, 'Cowork must not change Code session or plugin state');
  const debugLog = fs.readFileSync(debugLogPath, 'utf8');
  for (const payloadFragment of ['Help with this task', 'pwd', 'test response', SESSION_ID]) {
    assert.ok(!debugLog.includes(payloadFragment), `debug.log leaked payload content: ${payloadFragment}`);
  }
  assert.equal(debugLog.trimEnd().split('\n').length, HOOK_NAMES.length, 'One skip line per hook, and nothing else');
});

test('Cowork shared Bash and MCP tools remain inert even inside a git repository', async (t) => {
  const f = await fixture(t, true);
  const before = snapshot(f.root);
  for (const hook of ['PreToolUse', 'PostToolUse'] as const) {
    for (const tool of ['Bash', 'mcp__slack__search']) {
      const result = await runProcess(hookPath(hook), { ...f.env, CLAUDE_CODE_ENTRYPOINT: 'local-agent' }, f.input(hook, tool));
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, '');
    }
  }
  assert.deepEqual(f.requests, []);
  assert.deepEqual(snapshot(f.root), before);
});

test('detached MCP ingestion entrypoint also refuses Cowork work', async (t) => {
  const f = await fixture(t, true);
  const before = snapshot(f.root);
  for (const [, marker] of COWORK_SURFACES) {
    const result = await runProcess(path.join(PLUGIN_ROOT, 'dist/src/ingestMcpServers.js'), { ...f.env, ...marker }, null);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(f.requests, []);
  assert.deepEqual(snapshot(f.root), before);
});

const CODE_ENTRYPOINTS = ['cli', 'claude-vscode', 'claude-desktop', 'claude-desktop-3p', 'sdk-py', 'future-ide', undefined];

function assertAuthorizationOutput(hook: HookName, result: HookResult, allowed: boolean): void {
  assert.equal(result.code, 0, result.stderr);
  if (hook === 'PreToolUse') {
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, allowed ? 'allow' : 'deny');
  } else if (allowed) {
    assert.equal(result.stdout, '');
  } else {
    assert.equal(JSON.parse(result.stdout).decision, 'block');
  }
}

test('Code, future IDE and unidentified hosts enforce Reva decisions outside git repositories', async (t) => {
  const f = await fixture(t);
  for (const entrypoint of CODE_ENTRYPOINTS) {
    for (const hook of AUTHORIZATION_HOOKS) {
      for (const status of [200, 403]) {
        await t.test(`${entrypoint ?? 'missing entrypoint'}: ${hook}, HTTP ${status}`, async () => {
          f.response.status = status;
          const start = f.requests.filter((request) => request.url === '/pdp/v2/ai/evaluation').length;
          const env = { ...f.env, CLAUDE_CODE_ENTRYPOINT: entrypoint, __CFBundleIdentifier: 'com.anthropic.claudefordesktop' };
          const result = await runProcess(hookPath(hook), env, f.input(hook));
          assertAuthorizationOutput(hook, result, status === 200);
          assert.equal(f.requests.filter((request) => request.url === '/pdp/v2/ai/evaluation').length, start + 1);
        });
      }
    }
  }
});

test('Code malformed input and missing configuration still fail closed on every authorization hook', async (t) => {
  const f = await fixture(t);
  for (const entrypoint of CODE_ENTRYPOINTS) {
    for (const hook of AUTHORIZATION_HOOKS) {
      for (const failure of ['malformed input', 'missing token']) {
        await t.test(`${entrypoint ?? 'missing entrypoint'}: ${hook}, ${failure}`, async () => {
          const env: NodeJS.ProcessEnv = { ...f.env, CLAUDE_CODE_ENTRYPOINT: entrypoint };
          if (failure === 'missing token') delete env.REVA_AUTH_TOKEN;
          const result = await runProcess(hookPath(hook), env, failure === 'malformed input' ? '{not JSON' : f.input(hook));
          assertAuthorizationOutput(hook, result, false);
        });
      }
    }
  }
  assert.deepEqual(f.requests, [], 'Parsing/configuration failures must not make network calls');
});

test('new or unknown Code tools cannot evade governance through a tool-name allowlist', async (t) => {
  const f = await fixture(t);
  for (const hook of ['PreToolUse', 'PostToolUse'] as const) {
    const result = await runProcess(hookPath(hook), { ...f.env, CLAUDE_CODE_ENTRYPOINT: 'cli' }, f.input(hook, 'FutureCodeTool'));
    assertAuthorizationOutput(hook, result, false);
  }
  assert.equal(f.requests.filter((request) => request.url === '/pdp/v2/ai/evaluation').length, 2);
});

test('explicit Code or unknown entrypoints remain governed despite an inherited Cowork marker', async (t) => {
  const f = await fixture(t);
  let evaluations = 0;
  for (const entrypoint of CODE_ENTRYPOINTS) {
    if (entrypoint === undefined) continue;
    for (const hook of AUTHORIZATION_HOOKS) {
      const env = { ...f.env, CLAUDE_CODE_ENTRYPOINT: entrypoint, CLAUDE_CODE_IS_COWORK: '1' };
      const result = await runProcess(hookPath(hook), env, f.input(hook));
      assertAuthorizationOutput(hook, result, false);
      evaluations += 1;
    }
  }
  assert.equal(f.requests.filter((request) => request.url === '/pdp/v2/ai/evaluation').length, evaluations);
});
