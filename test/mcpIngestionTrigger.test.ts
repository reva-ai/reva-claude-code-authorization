import assert from 'node:assert/strict';
import { test } from 'node:test';
import { triggerMcpDiscoveryIfDue, triggerMcpIngestionForInvokedServer } from '../src/mcpIngestionTrigger';

test('triggerMcpDiscoveryIfDue does nothing when not due — no record, no spawn', () => {
  let recorded = false;
  let spawned = false;
  triggerMcpDiscoveryIfDue(
    '/some/cwd',
    'plugin-data-dir',
    () => false,
    () => {
      recorded = true;
    },
    () => {
      spawned = true;
    },
  );
  assert.equal(recorded, false);
  assert.equal(spawned, false);
});

test('triggerMcpDiscoveryIfDue records the trigger, then spawns, when due', () => {
  const calls: string[] = [];
  let spawnArgs: { cwd: string; pluginDataDir?: string } | undefined;
  triggerMcpDiscoveryIfDue(
    '/some/cwd',
    'plugin-data-dir',
    () => true,
    () => {
      calls.push('recorded');
    },
    (cwd, pluginDataDir) => {
      calls.push('spawned');
      spawnArgs = { cwd, pluginDataDir };
    },
  );
  // Recorded before spawned — a burst of calls in the same window must see
  // the record from the first one, not race each other into spawning twice.
  assert.deepEqual(calls, ['recorded', 'spawned']);
  assert.deepEqual(spawnArgs, { cwd: '/some/cwd', pluginDataDir: 'plugin-data-dir' });
});

test('triggerMcpDiscoveryIfDue passes pluginDataDir through to isDue/recordTriggered, cwd only to spawn', () => {
  const isDueArgs: (string | undefined)[] = [];
  const recordArgs: (string | undefined)[] = [];
  triggerMcpDiscoveryIfDue(
    '/some/cwd',
    'plugin-data-dir',
    (pluginDataDir) => {
      isDueArgs.push(pluginDataDir);
      return true;
    },
    (pluginDataDir) => {
      recordArgs.push(pluginDataDir);
    },
    () => {},
  );
  assert.deepEqual(isDueArgs, ['plugin-data-dir']);
  assert.deepEqual(recordArgs, ['plugin-data-dir']);
});

// --- ingest-on-invoke -------------------------------------------------------
// Called from the PreToolUse path for an MCP tool call. The common case — a
// server already ingested — must cost one known-name check and nothing else,
// because this runs before every single MCP tool call.

test('triggerMcpIngestionForInvokedServer does nothing for a server already ingested', () => {
  const calls: string[] = [];
  let dueChecked = false;
  triggerMcpIngestionForInvokedServer(
    'gmail',
    '/repo',
    '/data',
    () => true, // known
    () => {
      dueChecked = true;
      return true;
    },
    () => calls.push('record'),
    () => calls.push('spawn'),
  );
  assert.deepEqual(calls, []);
  // The known check must short-circuit BEFORE the throttle read — this is
  // the hot path for every MCP tool call on an already-ingested server.
  assert.equal(dueChecked, false);
});

test('triggerMcpIngestionForInvokedServer records then spawns for an unknown server', () => {
  const calls: string[] = [];
  triggerMcpIngestionForInvokedServer(
    'brand-new-server',
    '/repo',
    '/data',
    () => false,
    () => true,
    () => calls.push('record'),
    () => calls.push('spawn'),
  );
  // Recorded before spawning, same ordering as the periodic trigger: a burst
  // of calls to the same still-unknown server can't each spawn their own
  // overlapping child.
  assert.deepEqual(calls, ['record', 'spawn']);
});

test('triggerMcpIngestionForInvokedServer respects the throttle for an unknown server', () => {
  const calls: string[] = [];
  triggerMcpIngestionForInvokedServer(
    'brand-new-server',
    '/repo',
    '/data',
    () => false,
    () => false, // a pass was triggered moments ago
    () => calls.push('record'),
    () => calls.push('spawn'),
  );
  assert.deepEqual(calls, []);
});

test('triggerMcpIngestionForInvokedServer ignores an empty server name', () => {
  const calls: string[] = [];
  triggerMcpIngestionForInvokedServer(
    '',
    '/repo',
    '/data',
    () => false,
    () => true,
    () => calls.push('record'),
    () => calls.push('spawn'),
  );
  assert.deepEqual(calls, []);
});

test('triggerMcpIngestionForInvokedServer passes the server name and pluginDataDir through, cwd only to spawn', () => {
  const seen: Record<string, unknown> = {};
  triggerMcpIngestionForInvokedServer(
    'google-calendar',
    '/some/cwd',
    '/some/data',
    (name, dir) => {
      seen.knownName = name;
      seen.knownDir = dir;
      return false;
    },
    (dir) => {
      seen.dueDir = dir;
      return true;
    },
    (dir) => {
      seen.recordDir = dir;
    },
    (cwd, dir) => {
      seen.spawnCwd = cwd;
      seen.spawnDir = dir;
    },
  );
  assert.equal(seen.knownName, 'google-calendar');
  assert.equal(seen.knownDir, '/some/data');
  assert.equal(seen.dueDir, '/some/data');
  assert.equal(seen.recordDir, '/some/data');
  assert.equal(seen.spawnCwd, '/some/cwd');
  assert.equal(seen.spawnDir, '/some/data');
});

test('the invoked server name is handed to the spawned child — not just a bare discovery re-run', () => {
  // The bug this exists to prevent: the spawn used to pass only cwd, so the
  // child re-ran discovery and found nothing new for a server that lives in
  // no config file. The trigger fired and ingested nothing, every time.
  const seen: Record<string, unknown> = {};
  triggerMcpIngestionForInvokedServer(
    'claude-browser',
    '/some/cwd',
    '/some/data',
    () => false,
    () => true,
    () => {},
    (cwd, dir, invokedServer) => {
      seen.cwd = cwd;
      seen.dir = dir;
      seen.invokedServer = invokedServer;
    },
  );
  assert.equal(seen.invokedServer, 'claude-browser', 'the child must be told WHICH server was invoked');
  assert.equal(seen.cwd, '/some/cwd');
  assert.equal(seen.dir, '/some/data');
});
