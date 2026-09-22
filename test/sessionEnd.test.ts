import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { getActiveSessionCount, markSessionActive } from '../src/activeSessions';

// SessionEnd has no blocking/decision control at all — sessionEnd.ts must
// always exit 0 with empty stdout, no matter what. Exercised as a real
// subprocess (not a unit test of internal functions) for the resilience
// cases, since the contract that matters there is the process's exit code
// and stdout, exactly what Claude Code itself observes — same rationale as
// sessionStart.test.ts.
const ENTRYPOINT = path.join(__dirname, '..', 'src', 'sessionEnd.js');

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-session-end-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runSessionEnd(stdin: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [ENTRYPOINT], {
    input: stdin,
    env: { PATH: process.env.PATH || '', ...env },
    encoding: 'utf8',
    timeout: 5000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('valid input, no REVA_AGENT_ID and no logged-in account: exits 0 with empty stdout', () => {
  const { status, stdout } = runSessionEnd(JSON.stringify({ session_id: 's1', cwd: '/tmp' }));
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('malformed JSON on stdin: still exits 0 with empty stdout, never throws uncaught', () => {
  const { status, stdout } = runSessionEnd('{ not valid json');
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('empty stdin: still exits 0 with empty stdout', () => {
  const { status, stdout } = runSessionEnd('');
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('missing fields entirely (bare {}): still exits 0 with empty stdout', () => {
  const { status, stdout } = runSessionEnd('{}');
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

test('a real SessionEnd removes the session from the active-sessions registry, not just exits cleanly', () => {
  withTempDir((dir) => {
    markSessionActive('agent-real', 'sess-1', 'cli', dir);
    assert.equal(getActiveSessionCount('agent-real', dir), 1);

    const { status } = runSessionEnd(JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' }), {
      REVA_AGENT_ID: 'agent-real',
      CLAUDE_PLUGIN_DATA: dir,
    });

    assert.equal(status, 0);
    assert.equal(getActiveSessionCount('agent-real', dir), 0);
  });
});

test('SessionEnd for one session leaves a different concurrent session untouched', () => {
  withTempDir((dir) => {
    markSessionActive('agent-real', 'sess-1', 'cli', dir);
    markSessionActive('agent-real', 'sess-2', 'claude-desktop', dir);
    assert.equal(getActiveSessionCount('agent-real', dir), 2);

    runSessionEnd(JSON.stringify({ session_id: 'sess-1', cwd: '/tmp' }), {
      REVA_AGENT_ID: 'agent-real',
      CLAUDE_PLUGIN_DATA: dir,
    });

    assert.equal(getActiveSessionCount('agent-real', dir), 1);
  });
});
