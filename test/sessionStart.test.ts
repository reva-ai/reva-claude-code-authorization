import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

// SessionStart has no blocking/decision control at all — sessionStart.ts
// must always exit 0 with empty stdout, no matter what. Exercised as a real
// subprocess (not a unit test of internal functions) because the contract
// that actually matters here is the process's exit code and stdout, which
// is exactly what Claude Code itself observes.
//
// Runs with a deliberately clean, minimal env — no REVA_AUTH_TOKEN —
// so this never makes a real network call
// regardless of what's set in the developer's own shell.
const ENTRYPOINT = path.join(__dirname, '..', 'src', 'sessionStart.js');
const CLEAN_ENV = { PATH: process.env.PATH || '' };

function runSessionStart(stdin: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [ENTRYPOINT], {
    input: stdin,
    env: CLEAN_ENV,
    encoding: 'utf8',
    timeout: 5000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('valid input, plugin not configured at all: exits 0 with empty stdout', () => {
  const { status, stdout } = runSessionStart(JSON.stringify({ session_id: 's1', cwd: '/tmp', source: 'startup' }));
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('malformed JSON on stdin: still exits 0 with empty stdout, never throws uncaught', () => {
  const { status, stdout } = runSessionStart('{ not valid json');
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('empty stdin: still exits 0 with empty stdout', () => {
  const { status, stdout } = runSessionStart('');
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('missing fields entirely (bare {}): still exits 0 with empty stdout', () => {
  const { status, stdout } = runSessionStart('{}');
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

// Regression coverage for the actual production incident this fixed:
// ingestion used to run fully inline and fully sequential on this hook's
// own process, so a slow or unreachable Reva tenant stalled session startup
// itself — observed live as Claude Desktop's Chat/Cowork surfaces hanging
// on "Working on it…" for a plain "hello", cured only by disabling the
// plugin. sessionStart.ts now deliberately still waits for User/Agent
// ingestion (Cedar policies can check a STORED registration, e.g.
// machineId against User.registeredMachineIds, which needs that PATCH to
// have already landed) — but User and Agent run concurrently, and MCP
// server discovery (the most expensive, least bounded part) is fully
// detached, so the bound here is one ingestion timeout, not four-plus
// stacked sequentially.
//
// REVA_HOST below points at 192.0.2.1 (RFC 5737 TEST-NET-1, guaranteed
// non-routable) specifically so the connection hangs until the ingestion
// timeout instead of failing fast — a fast local refusal wouldn't
// distinguish "one bounded wait" from "several stacked." Per this repo's
// standing rule, every live-ish test overrides REVA_HOST explicitly rather
// than ever touching a real tenant.
test('valid config, unreachable host: bounded by one ingestion timeout, not several stacked', () => {
  const env = {
    PATH: process.env.PATH || '',
    REVA_AUTH_TOKEN: 'test-token',
    REVA_AGENT_ID: 'test-agent',
    REVA_HOST: '192.0.2.1',
  };
  const start = Date.now();
  const { status, stdout } = spawnSync(process.execPath, [ENTRYPOINT], {
    input: JSON.stringify({ session_id: 's-timing', cwd: '/tmp', source: 'startup' }),
    env,
    encoding: 'utf8',
    timeout: 8000,
  });
  const elapsedMs = Date.now() - start;
  assert.equal(status, 0);
  assert.equal(stdout, '');
  // Against an unreachable host, resolveEntityTypeIds fails first — so
  // userEntityTypeId/agentEntityTypeId both come back unresolved and
  // ingestUser/ingestAgent are never even attempted. Total wait is exactly
  // one 5s ingestion timeout (config.ts's DEFAULT_INGESTION_TIMEOUT_MS),
  // not several stacked — the old fully-sequential implementation, walking
  // resolveEntityTypeIds/ingestUser/ingestAgent/MCP discovery in turn,
  // could run past a minute on the same host.
  assert.ok(elapsedMs >= 4500, `expected sessionStart.js to actually wait on ingestion, took only ${elapsedMs}ms`);
  assert.ok(elapsedMs < 7000, `expected a single bounded wait, took ${elapsedMs}ms`);
});

// The actual behavior change this fix is about: User and Agent used to be
// awaited one after another; now they run concurrently via Promise.all.
// Proven with a tiny local server that delays every entity-existence GET by
// a fixed amount — sequential would cost roughly 2x that delay end to end,
// concurrent roughly 1x. A black-hole IP (used above) can't distinguish
// these two shapes since both would just hit the same timeout; this needs
// a server that actually responds, just slowly.
const MOCK_SERVER_ENTRYPOINT = path.join(__dirname, 'support', 'delayedIngestionServer.js');

// Runs test/support/delayedIngestionServer.js as a genuinely separate OS
// process — an http.createServer hosted inside this test runner's own
// process is unreachable from a spawnSync'd child in this environment's
// sandbox, even over plain loopback TCP, so this mirrors how sessionStart.js
// actually talks to a real Reva tenant: a real, independent process on the
// other end of a real socket.
function startDelayedIngestionServer(delayMs: number): Promise<{ port: number; stop: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MOCK_SERVER_ENTRYPOINT, String(delayMs)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const port = Number(buffer.slice(0, newlineIndex).trim());
        resolve({ port, stop: () => child.kill() });
      }
    });
    child.on('error', reject);
  });
}

test('valid config, working but slow tenant: User and Agent ingestion run concurrently', async () => {
  const DELAY_MS = 1000;
  const { port, stop } = await startDelayedIngestionServer(DELAY_MS);
  try {
    const env = {
      PATH: process.env.PATH || '',
      REVA_AUTH_TOKEN: 'test-token',
      REVA_AGENT_ID: 'test-agent',
      REVA_HOST: `127.0.0.1:${port}`,
    };
    const start = Date.now();
    const { status } = spawnSync(process.execPath, [ENTRYPOINT], {
      input: JSON.stringify({ session_id: 's-parallel', cwd: '/tmp', source: 'startup' }),
      env,
      encoding: 'utf8',
      timeout: 8000,
    });
    const elapsedMs = Date.now() - start;
    assert.equal(status, 0);
    // Sequential (the old shape) would be roughly 2x DELAY_MS end to end
    // (ingestUser's existence check, then ingestAgent's, one after the
    // other) plus overhead; concurrent is roughly 1x DELAY_MS. This ceiling
    // sits clearly below the sequential number and clearly above the
    // concurrent one.
    assert.ok(elapsedMs < DELAY_MS * 1.8, `expected concurrent ingestion (~${DELAY_MS}ms), took ${elapsedMs}ms — looks sequential`);
  } finally {
    stop();
  }
});

test('valid config: MCP server discovery runs detached, after this process has already exited', async () => {
  const pluginDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-sessionstart-'));
  try {
    const env = {
      PATH: process.env.PATH || '',
      REVA_AUTH_TOKEN: 'test-token',
      REVA_AGENT_ID: 'test-agent',
      REVA_HOST: '192.0.2.1',
      REVA_DEBUG: '1',
      CLAUDE_PLUGIN_DATA: pluginDataDir,
    };
    const { status } = spawnSync(process.execPath, [ENTRYPOINT], {
      input: JSON.stringify({ session_id: 's-detach', cwd: '/tmp', source: 'startup' }),
      env,
      encoding: 'utf8',
      timeout: 8000,
    });
    assert.equal(status, 0);

    const logPath = path.join(pluginDataDir, 'debug.log');
    const deadline = Date.now() + 8000;
    let content = '';
    while (Date.now() < deadline) {
      content = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
      if (content.includes('ingestMcpServers:')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(content, /ingestMcpServers: skipped — could not resolve MCPServer entity type id/);
  } finally {
    fs.rmSync(pluginDataDir, { recursive: true, force: true });
  }
});
