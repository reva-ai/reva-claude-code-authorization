import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  clearSessionModel,
  loadRecordedSessionModel,
  normalizeModel,
  readLatestTranscriptModel,
  recordSessionModel,
  resolveSessionModel,
} from '../src/sessionModel';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-model-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Mirrors the real Claude Code transcript JSONL: assistant entries carry
// message.model plus an ISO timestamp; other entry types carry neither.
function writeTranscript(dir: string, entries: (object | string)[]): string {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, entries.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join('\n') + '\n', 'utf8');
  return file;
}

function assistant(model: string, timestamp: string, extra: object = {}): object {
  return { type: 'assistant', isSidechain: false, timestamp, message: { role: 'assistant', model, content: [] }, ...extra };
}

test('normalizeModel trims, and rejects blanks, non-strings and the <synthetic> placeholder', () => {
  assert.equal(normalizeModel('  claude-opus-5-5 '), 'claude-opus-5-5');
  assert.equal(normalizeModel(''), undefined);
  assert.equal(normalizeModel('   '), undefined);
  assert.equal(normalizeModel(undefined), undefined);
  assert.equal(normalizeModel(42), undefined);
  assert.equal(normalizeModel('<synthetic>'), undefined);
});

test('recordSessionModel round-trips through loadRecordedSessionModel, and clearSessionModel removes it', () => {
  withTempDir((dir) => {
    recordSessionModel('sess-1', 'claude-sonnet-5-5', dir, '2026-11-03T10:00:00.000Z');
    assert.deepEqual(loadRecordedSessionModel('sess-1', dir), {
      model: 'claude-sonnet-5-5',
      observedAt: '2026-11-03T10:00:00.000Z',
    });
    assert.equal(loadRecordedSessionModel('other-session', dir), undefined);
    clearSessionModel('sess-1', dir);
    assert.equal(loadRecordedSessionModel('sess-1', dir), undefined);
  });
});

test('recordSessionModel is a no-op without CLAUDE_PLUGIN_DATA or without a real model', () => {
  withTempDir((dir) => {
    recordSessionModel('sess-1', 'claude-opus-5-5', undefined);
    recordSessionModel('sess-1', '', dir);
    assert.equal(loadRecordedSessionModel('sess-1', dir), undefined);
    assert.equal(fs.existsSync(path.join(dir, 'session-models')), false);
  });
});

test('readLatestTranscriptModel returns the newest main-thread assistant model', () => {
  withTempDir((dir) => {
    const file = writeTranscript(dir, [
      { type: 'user', timestamp: '2026-11-03T10:00:00.000Z', message: { role: 'user', content: 'hi' } },
      assistant('claude-sonnet-5-5', '2026-11-03T10:00:01.000Z'),
      assistant('claude-opus-5-5', '2026-11-03T10:05:00.000Z'),
      // Newer, but must be skipped: a subagent's turn and a synthetic error entry.
      assistant('claude-haiku-5-5', '2026-11-03T10:06:00.000Z', { isSidechain: true }),
      assistant('<synthetic>', '2026-11-03T10:07:00.000Z'),
      { type: 'user', timestamp: '2026-11-03T10:08:00.000Z', message: { role: 'user', content: 'next' } },
      'not json at all',
    ]);
    assert.deepEqual(readLatestTranscriptModel(file), {
      model: 'claude-opus-5-5',
      observedAt: '2026-11-03T10:05:00.000Z',
    });
  });
});

test('readLatestTranscriptModel returns undefined for a missing or model-less transcript', () => {
  withTempDir((dir) => {
    assert.equal(readLatestTranscriptModel(undefined), undefined);
    assert.equal(readLatestTranscriptModel(path.join(dir, 'missing.jsonl')), undefined);
    const file = writeTranscript(dir, [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
    assert.equal(readLatestTranscriptModel(file), undefined);
  });
});

test('readLatestTranscriptModel finds the model when only the tail of a large transcript is read', () => {
  withTempDir((dir) => {
    const filler = { type: 'user', message: { role: 'user', content: 'x'.repeat(4096) } };
    const entries: object[] = [assistant('claude-sonnet-5-5', '2026-11-03T09:00:00.000Z')];
    for (let i = 0; i < 400; i++) entries.push(filler); // ~1.6 MiB, past the tail window
    entries.push(assistant('claude-opus-5-5', '2026-11-03T10:00:00.000Z'));
    const file = writeTranscript(dir, entries);
    assert.equal(readLatestTranscriptModel(file)?.model, 'claude-opus-5-5');
  });
});

test('resolveSessionModel: SessionStart value only — first prompt of a fresh session', () => {
  withTempDir((dir) => {
    recordSessionModel('sess-1', 'claude-opus-5-5', dir);
    assert.deepEqual(resolveSessionModel('sess-1', undefined, dir), {
      model: 'claude-opus-5-5',
      source: 'sessionStart',
    });
  });
});

test('resolveSessionModel: a newer transcript entry wins — picks up a mid-session /model switch', () => {
  withTempDir((dir) => {
    recordSessionModel('sess-1', 'claude-opus-5-5', dir, '2026-11-03T10:00:00.000Z');
    const file = writeTranscript(dir, [assistant('claude-sonnet-5-5', '2026-11-03T10:30:00.000Z')]);
    assert.deepEqual(resolveSessionModel('sess-1', file, dir), { model: 'claude-sonnet-5-5', source: 'transcript' });
  });
});

test('resolveSessionModel: a newer SessionStart wins over an older transcript — a resumed session', () => {
  withTempDir((dir) => {
    const file = writeTranscript(dir, [assistant('claude-sonnet-5-5', '2026-11-02T10:00:00.000Z')]);
    recordSessionModel('sess-1', 'claude-opus-5-5', dir, '2026-11-03T10:00:00.000Z');
    assert.deepEqual(resolveSessionModel('sess-1', file, dir), { model: 'claude-opus-5-5', source: 'sessionStart' });
  });
});

test('resolveSessionModel: transcript alone works with no CLAUDE_PLUGIN_DATA', () => {
  withTempDir((dir) => {
    const file = writeTranscript(dir, [assistant('claude-opus-5-5', '2026-11-03T10:00:00.000Z')]);
    assert.deepEqual(resolveSessionModel('sess-1', file, undefined), { model: 'claude-opus-5-5', source: 'transcript' });
  });
});

test('resolveSessionModel: nothing known resolves to no model, never a placeholder', () => {
  withTempDir((dir) => {
    assert.deepEqual(resolveSessionModel('sess-1', path.join(dir, 'missing.jsonl'), dir), { source: 'none' });
  });
});

// The real entrypoints, as subprocesses — what Claude Code itself runs.
const SESSION_START = path.join(__dirname, '..', 'src', 'sessionStart.js');
const SESSION_END = path.join(__dirname, '..', 'src', 'sessionEnd.js');

function runHook(entrypoint: string, stdin: object, pluginDataDir: string) {
  return spawnSync(process.execPath, [entrypoint], {
    input: JSON.stringify(stdin),
    // No REVA_AUTH_TOKEN: model capture is local bookkeeping and must work
    // (and never make a network call) without any Reva config.
    env: { PATH: process.env.PATH || '', CLAUDE_PLUGIN_DATA: pluginDataDir },
    encoding: 'utf8',
    timeout: 5000,
  });
}

for (const source of ['startup', 'resume', 'clear', 'compact']) {
  test(`SessionStart (source=${source}) records the payload model, exits 0, no stdout`, () => {
    withTempDir((dir) => {
      const result = runHook(SESSION_START, { session_id: `s-${source}`, cwd: dir, source, model: 'claude-opus-5-5' }, dir);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '');
      assert.equal(loadRecordedSessionModel(`s-${source}`, dir)?.model, 'claude-opus-5-5');
    });
  });
}

test('SessionStart with no model in the payload records nothing and still exits 0', () => {
  withTempDir((dir) => {
    const result = runHook(SESSION_START, { session_id: 's1', cwd: dir, source: 'startup' }, dir);
    assert.equal(result.status, 0);
    assert.equal(loadRecordedSessionModel('s1', dir), undefined);
  });
});

test('SessionEnd removes the session’s recorded model', () => {
  withTempDir((dir) => {
    recordSessionModel('s1', 'claude-opus-5-5', dir);
    const result = runHook(SESSION_END, { session_id: 's1', cwd: dir }, dir);
    assert.equal(result.status, 0);
    assert.equal(loadRecordedSessionModel('s1', dir), undefined);
  });
});
