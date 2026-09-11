import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runPreToolHook(status: number, body: object, dataDir: string): Promise<HookRun> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const hookPath = path.resolve(__dirname, '../src/authorize.js');
    const child = spawn(process.execPath, [hookPath], {
      env: {
        ...process.env,
        REVA_HOST: `http://127.0.0.1:${address.port}`,
        REVA_AUTH_TOKEN: 'test-token',
        // HOME is redirected to the fresh temp dataDir below, so there's no
        // real ~/.claude.json for this subprocess to read — resolveAgentId()
        // has no fallback (see deviceId.ts), so REVA_AGENT_ID must be set
        // explicitly here the same way REVA_AUTH_TOKEN already is.
        REVA_AGENT_ID: 'hook-test-agent',
        CLAUDE_PLUGIN_DATA: dataDir,
        HOME: dataDir,
        USER: 'hook-test-user',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.stdin.end(
      JSON.stringify({
        session_id: `session-${status}`,
        cwd: dataDir,
        tool_name: 'Read',
        tool_input: { file_path: path.join(dataDir, 'example.txt') },
      }),
    );
    return await new Promise<HookRun>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

test('PreToolUse emits no decision while 401/5xx inactivity circuits are open', async (t) => {
  for (const [status, body] of [
    [401, { decision: false, error_type: 'USER_DISABLED' }],
    [503, { decision: false, error_type: 'POLICY_ENGINE_UNAVAILABLE' }],
  ] as const) {
    await t.test(`HTTP ${status}`, async (t) => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `reva-hook-${status}-`));
      t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
      const result = await runPreToolHook(status, body, dataDir);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, '');
    });
  }
});

test('PreToolUse still emits allow for 200 and deny for 403', async (t) => {
  for (const [status, body, expected] of [
    [200, { decision: true }, 'allow'],
    [403, { decision: false, error_type: 'POLICY_DENIED', context: { reason: 'denied' } }, 'deny'],
  ] as const) {
    await t.test(`HTTP ${status}`, async (t) => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `reva-hook-${status}-`));
      t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
      const result = await runPreToolHook(status, body, dataDir);
      assert.equal(result.code, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.permissionDecision, expected);
    });
  }
});
