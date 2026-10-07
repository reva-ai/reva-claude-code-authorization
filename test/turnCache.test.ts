import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  cleanSubmittedPrompt,
  conversationFromTurn,
  directSessionFromTurn,
  loadOrStartTurn,
  loadTurn,
  resolveTurnTraceId,
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
    assert.equal(loaded?.traceId, turn.traceId);
    assert.equal(loaded?.prompt, 'do the thing');
    assert.equal(loaded?.turn, 1);
    assert.match(loaded?.startedAt || '', /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('a second startTurn call for the same session overwrites the previous turn', () => {
  withTempDir((dir) => {
    const first = startTurn('sess-1', 'turn one prompt', dir);
    const second = startTurn('sess-1', 'turn two prompt', dir);
    assert.notEqual(first.traceId, second.traceId);
    const loaded = loadTurn('sess-1', dir);
    assert.equal(loaded?.traceId, second.traceId);
    assert.equal(loaded?.prompt, 'turn two prompt');
    assert.equal(loaded?.turn, 2);
    assert.equal(second.startedAt, first.startedAt);
  });
});

test('different sessions get independent turn entries', () => {
  withTempDir((dir) => {
    const a = startTurn('sess-a', 'prompt a', dir);
    const b = startTurn('sess-b', 'prompt b', dir);
    assert.notEqual(a.traceId, b.traceId);
    assert.equal(loadTurn('sess-a', dir)?.traceId, a.traceId);
    assert.equal(loadTurn('sess-b', dir)?.traceId, b.traceId);
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
    assert.equal(loaded?.traceId, turn.traceId);
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

test('truncatePrompt keeps a prompt of up to 10000 characters whole', () => {
  const prompt = 'x'.repeat(10000);
  assert.equal(truncatePrompt(prompt), prompt);
});

test('truncatePrompt cuts a longer prompt to 10000 characters plus an ellipsis', () => {
  const truncated = truncatePrompt('x'.repeat(10001));
  assert.equal(truncated, `${'x'.repeat(10000)}…`);
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

test('with no pluginDataDir the trace id is derived, so separate hooks still share a turn', () => {
  // A minted id can only be shared if it can be persisted — every later hook
  // in the turn is its own process and reads it back from the cache. Without
  // a cache to write to, minting would give each process a different random
  // id and the turn would fragment into one trace per RTG call.
  const a = resolveTurnTraceId('sess-nodir', loadOrStartTurn('sess-nodir', undefined));
  const b = resolveTurnTraceId('sess-nodir', loadOrStartTurn('sess-nodir', undefined));
  assert.equal(a, b, 'separate processes must agree with no cache available');
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('an upgrade from a pre-traceId cache entry keeps the turn and derives a shared trace', () => {
  withTempDir((dir) => {
    // Exactly the shape written before traceId existed: spanId, no traceId.
    fs.mkdirSync(path.join(dir, 'turns'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'turns', 'sess-old.json'),
      JSON.stringify({
        spanId: 'c515b2193e5f1234',
        promptTimestamp: '2026-09-20T10:00:00.000Z',
        turn: 13,
        startedAt: '2026-09-20T09:00:00.000Z',
        prompt: 'an older prompt',
      }),
      'utf8',
    );

    const turn = loadOrStartTurn('sess-old', dir);
    // The turn must be REUSED, not restarted — restarting would bump the
    // counter and lose the conversation's own history.
    assert.equal(turn.turn, 13);
    assert.equal(turn.startedAt, '2026-09-20T09:00:00.000Z');
    assert.equal(turn.traceId, undefined);

    // …and every hook still agrees on a trace for it, via the fallback.
    const first = resolveTurnTraceId('sess-old', turn);
    const second = resolveTurnTraceId('sess-old', loadOrStartTurn('sess-old', dir));
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f]{32}$/);

    // The next prompt recovers to a minted id and drops the stale field.
    const next = startTurn('sess-old', 'next prompt', dir);
    assert.match(next.traceId || '', /^[0-9a-f]{32}$/);
    assert.equal(next.turn, 14);
    assert.equal(next.startedAt, '2026-09-20T09:00:00.000Z');
    assert.ok(!('spanId' in next));
  });
});

test('cleanSubmittedPrompt removes the paste tags and keeps the pasted text', () => {
  const prompt = 'I also saw this\n\n<pasted_content id="43b7">\ntofu init failed\n</pasted_content id="43b7">\n\ncan you check';
  assert.equal(cleanSubmittedPrompt(prompt), 'I also saw this\n\n\ntofu init failed\n\n\ncan you check');
});

test('cleanSubmittedPrompt handles several pastes and paste tags without an id', () => {
  const prompt = '<pasted_content id="a1">one</pasted_content id="a1"> and <pasted_content>two</pasted_content>';
  assert.equal(cleanSubmittedPrompt(prompt), 'one and two');
});

test('cleanSubmittedPrompt removes a reminder the host wrote ahead of the user prompt', () => {
  const prompt = '<system-reminder>\nThe user started this session without choosing a project folder…\n</system-reminder>\nfix the login bug';
  assert.equal(cleanSubmittedPrompt(prompt), 'fix the login bug');
});

test('cleanSubmittedPrompt removes reminders anywhere outside a paste', () => {
  const prompt = 'fix the login bug\n<system-reminder>one</system-reminder>\nand the logout bug<system-reminder>two</system-reminder>';
  assert.equal(cleanSubmittedPrompt(prompt), 'fix the login bug\n\nand the logout bug');
});

test('cleanSubmittedPrompt keeps a reminder the user pasted', () => {
  const prompt = 'why is this sent?\n<pasted_content id="b78a">\n<system-reminder>note</system-reminder>\n</pasted_content id="b78a">';
  assert.equal(cleanSubmittedPrompt(prompt), 'why is this sent?\n\n<system-reminder>note</system-reminder>');
});

test('cleanSubmittedPrompt stops an unclosed reminder at the next paste', () => {
  assert.equal(cleanSubmittedPrompt('look <system-reminder>cut off'), 'look');
  assert.equal(
    cleanSubmittedPrompt('<system-reminder>cut off <pasted_content id="c1">kept</pasted_content id="c1">'),
    'kept',
  );
});

test('cleanSubmittedPrompt removes a stray paste tag with no partner', () => {
  assert.equal(cleanSubmittedPrompt('see <pasted_content id="d1">half a paste'), 'see half a paste');
});

test('cleanSubmittedPrompt keeps the original when the message is only a reminder', () => {
  const prompt = '<system-reminder>host note only</system-reminder>';
  assert.equal(cleanSubmittedPrompt(prompt), prompt);
});

test('cleanSubmittedPrompt returns an ordinary prompt unchanged', () => {
  const prompt = 'fix the <div> layout in app.tsx';
  assert.equal(cleanSubmittedPrompt(prompt), prompt);
});

test('a long host reminder no longer pushes the user prompt past the cut', () => {
  const prompt = `<system-reminder>${'x'.repeat(12000)}</system-reminder>\nfix the login bug`;
  assert.equal(truncatePrompt(cleanSubmittedPrompt(prompt)), 'fix the login bug');
});
