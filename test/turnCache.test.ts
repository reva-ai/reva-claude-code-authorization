import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  conversationFromTurn,
  directSessionFromTurn,
  loadTurn,
  startTurn,
  truncatePrompt,
} from '../src/turnCache';

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-turn-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('startTurn persists a span id that loadTurn reads back for the same session', () => {
  withTempDir((dir) => {
    const turn = startTurn('sess-1', 'do the thing', dir);
    const loaded = loadTurn('sess-1', dir);
    assert.equal(loaded?.spanId, turn.spanId);
    assert.equal(loaded?.prompt, 'do the thing');
    assert.equal(loaded?.turn, 1);
    assert.match(loaded?.startedAt || '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('a second startTurn call for the same session overwrites the previous turn', () => {
  withTempDir((dir) => {
    const first = startTurn('sess-1', 'turn one prompt', dir);
    const second = startTurn('sess-1', 'turn two prompt', dir);
    assert.notEqual(first.spanId, second.spanId);
    const loaded = loadTurn('sess-1', dir);
    assert.equal(loaded?.spanId, second.spanId);
    assert.equal(loaded?.prompt, 'turn two prompt');
    assert.equal(loaded?.turn, 2);
    assert.equal(second.startedAt, first.startedAt);
  });
});

test('different sessions get independent turn entries', () => {
  withTempDir((dir) => {
    const a = startTurn('sess-a', 'prompt a', dir);
    const b = startTurn('sess-b', 'prompt b', dir);
    assert.notEqual(a.spanId, b.spanId);
    assert.equal(loadTurn('sess-a', dir)?.spanId, a.spanId);
    assert.equal(loadTurn('sess-b', dir)?.spanId, b.spanId);
  });
});

test('loadTurn returns undefined for a session that never started a turn', () => {
  withTempDir((dir) => {
    assert.equal(loadTurn('never-seen', dir), undefined);
  });
});

test('a prompt-less turn still gets a span id, with no prompt field', () => {
  withTempDir((dir) => {
    const turn = startTurn('sess-1', undefined, dir);
    const loaded = loadTurn('sess-1', dir);
    assert.equal(loaded?.spanId, turn.spanId);
    assert.equal(loaded?.prompt, undefined);
  });
});

test('direct session is metadata-only and conversation uses the observed prompt timestamp', () => {
  withTempDir((dir) => {
    const turn = startTurn('sess-1', 'do the thing', dir);
    assert.deepEqual(directSessionFromTurn('sess-1', turn), {
      id: 'sess-1',
      turn: 1,
      startedAt: turn.startedAt,
    });
    assert.equal('messages' in directSessionFromTurn('sess-1', turn), false);
    assert.deepEqual(conversationFromTurn(turn), [
      {
        seq: 1,
        role: 'user',
        contentType: 'text/plain',
        content: 'do the thing',
        timestamp: turn.promptTimestamp,
      },
    ]);
  });
});

test('truncatePrompt caps very long prompts', () => {
  const long = 'x'.repeat(3000);
  const truncated = truncatePrompt(long);
  assert.ok(truncated.length < long.length);
  assert.ok(truncated.endsWith('…'));
});

test('truncatePrompt leaves short prompts untouched', () => {
  assert.equal(truncatePrompt('short prompt'), 'short prompt');
});

test('with no pluginDataDir, startTurn/loadTurn still work but never persist — no fallback to a home-directory dotfile', () => {
  const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
  const existedBefore = fs.existsSync(homeRevaGovernance);

  const turn = startTurn('sess-1', 'hello', undefined);
  assert.equal(turn.turn, 1); // still a usable entry for this call
  assert.equal(loadTurn('sess-1', undefined), undefined); // but never actually persisted

  assert.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});
