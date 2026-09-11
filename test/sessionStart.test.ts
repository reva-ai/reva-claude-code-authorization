import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
