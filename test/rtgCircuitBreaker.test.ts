import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { checkCircuitBreaker, tripCircuitBreaker } from '../src/rtgCircuitBreaker';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-circuit-breaker-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Matches rtgCircuitBreaker.ts's own (unexported) cacheFile() convention —
// needed here only to hand-write an already-expired or malformed entry.
function cacheFile(dir: string, agentId: string): string {
  return path.join(dir, 'rtg-circuit-breaker', `${agentId}.json`);
}

test('no breaker has ever tripped — not disabled', () => {
  withTempDir((dir) => {
    const status = checkCircuitBreaker('agent-1', dir);
    assert.equal(status.disabled, false);
  });
});

test('tripCircuitBreaker opens the breaker for the given duration, carrying status/errorType through', () => {
  withTempDir((dir) => {
    tripCircuitBreaker('agent-1', 60_000, 500, 'RTG_SERVER_ERROR', dir);
    const status = checkCircuitBreaker('agent-1', dir);
    assert.equal(status.disabled, true);
    assert.equal(status.triggeredStatus, 500);
    assert.equal(status.errorType, 'RTG_SERVER_ERROR');
    assert.ok(status.disabledUntil! > Date.now());
  });
});

test('a window in the past reports as not disabled', () => {
  withTempDir((dir) => {
    tripCircuitBreaker('agent-1', -1000, 503, 'RTG_UNAVAILABLE', dir);
    const status = checkCircuitBreaker('agent-1', dir);
    assert.equal(status.disabled, false);
  });
});

test('different agents get independent breakers', () => {
  withTempDir((dir) => {
    tripCircuitBreaker('agent-1', 60_000, 401, 'UNAUTHORIZED', dir);
    assert.equal(checkCircuitBreaker('agent-1', dir).disabled, true);
    assert.equal(checkCircuitBreaker('agent-2', dir).disabled, false);
  });
});

test('a later trip call replaces the previous window rather than merging with it', () => {
  withTempDir((dir) => {
    tripCircuitBreaker('agent-1', 60_000, 500, 'RTG_SERVER_ERROR', dir);
    tripCircuitBreaker('agent-1', 60_000, 424, 'RTG_FAILED_DEPENDENCY', dir);
    const status = checkCircuitBreaker('agent-1', dir);
    assert.equal(status.triggeredStatus, 424);
    assert.equal(status.errorType, 'RTG_FAILED_DEPENDENCY');
  });
});

test('malformed state file is treated as not disabled, not a crash', () => {
  withTempDir((dir) => {
    fs.mkdirSync(path.dirname(cacheFile(dir, 'agent-1')), { recursive: true });
    fs.writeFileSync(cacheFile(dir, 'agent-1'), 'not json', 'utf8');
    const status = checkCircuitBreaker('agent-1', dir);
    assert.equal(status.disabled, false);
  });
});

test('with no pluginDataDir, checkCircuitBreaker always reports not disabled and tripCircuitBreaker is a harmless no-op', () => {
  assert.equal(checkCircuitBreaker('agent-1').disabled, false);
  assert.doesNotThrow(() => tripCircuitBreaker('agent-1', 60_000, 500, 'RTG_SERVER_ERROR'));
  assert.equal(checkCircuitBreaker('agent-1').disabled, false);
});
