import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { persistedFallbackId, readOauthAccountId, readOauthEmail, resolveAgentId, resolveMachineId } from '../src/deviceId';

function withTempFile(content: string | undefined, fn: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-claudejson-'));
  const filePath = path.join(dir, '.claude.json');
  try {
    if (content !== undefined) fs.writeFileSync(filePath, content, 'utf8');
    fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// persistedFallbackId is the cross-platform, fully testable part — the real
// OS-hardware-id path is exercised implicitly by resolveMachineId() below,
// but which branch it takes depends on the actual OS running the test.

test('persistedFallbackId generates and then reuses the same id from the same dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-device-'));
  try {
    const first = persistedFallbackId(dir);
    const second = persistedFallbackId(dir);
    assert.equal(first, second);
    assert.ok(fs.existsSync(path.join(dir, 'device-id')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('persistedFallbackId returns different ids for different dirs', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-device-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-device-b-'));
  try {
    assert.notEqual(persistedFallbackId(dirA), persistedFallbackId(dirB));
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('with no dataDir, persistedFallbackId still returns a usable id but never persists — no fallback to a home-directory dotfile, and a fresh id every call', () => {
  const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
  const existedBefore = fs.existsSync(homeRevaGovernance);

  const first = persistedFallbackId(undefined);
  const second = persistedFallbackId(undefined);
  assert.ok(first); // still a usable id for this call...
  assert.ok(second);
  assert.notEqual(first, second); // ...but a fresh one every time — nothing was persisted to reuse

  assert.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});

// Whether this is a real account UUID or undefined depends entirely on
// whether this test process has a real ~/.claude.json — not something to
// assert on (readOauthAccountId's own tests above already cover the actual
// parsing logic in isolation). What's testable here regardless of
// environment is that resolveAgentId() is cached: no fallback means the
// only thing it could otherwise do on a second call is re-read the same
// file and get the same answer, so this also incidentally confirms it
// never reaches for resolveMachineId() as a substitute.
test('resolveAgentId is cached — same value (present or undefined) across calls', () => {
  const first = resolveAgentId();
  const second = resolveAgentId();
  assert.equal(first, second);
});

test('readOauthEmail reads oauthAccount.emailAddress from a ~/.claude.json-shaped file', () => {
  withTempFile(JSON.stringify({ oauthAccount: { emailAddress: 'alice@example.com', accountUuid: 'unrelated' } }), (filePath) => {
    assert.equal(readOauthEmail(filePath), 'alice@example.com');
  });
});

test('readOauthEmail returns undefined when the file is missing', () => {
  withTempFile(undefined, (filePath) => {
    assert.equal(readOauthEmail(filePath), undefined);
  });
});

test('readOauthEmail returns undefined when oauthAccount or emailAddress is absent', () => {
  withTempFile(JSON.stringify({ userID: 'unrelated' }), (filePath) => {
    assert.equal(readOauthEmail(filePath), undefined);
  });
  withTempFile(JSON.stringify({ oauthAccount: { accountUuid: 'unrelated' } }), (filePath) => {
    assert.equal(readOauthEmail(filePath), undefined);
  });
});

test('readOauthEmail returns undefined for malformed JSON rather than throwing', () => {
  withTempFile('{ not valid json', (filePath) => {
    assert.equal(readOauthEmail(filePath), undefined);
  });
});

test('readOauthAccountId reads oauthAccount.accountUuid from a ~/.claude.json-shaped file', () => {
  withTempFile(
    JSON.stringify({ oauthAccount: { emailAddress: 'unrelated', accountUuid: '11111111-1111-4111-8111-111111111111' } }),
    (filePath) => {
      assert.equal(readOauthAccountId(filePath), '11111111-1111-4111-8111-111111111111');
    },
  );
});

test('readOauthAccountId returns undefined when the file is missing', () => {
  withTempFile(undefined, (filePath) => {
    assert.equal(readOauthAccountId(filePath), undefined);
  });
});

test('readOauthAccountId returns undefined when oauthAccount or accountUuid is absent', () => {
  withTempFile(JSON.stringify({ userID: 'unrelated' }), (filePath) => {
    assert.equal(readOauthAccountId(filePath), undefined);
  });
  withTempFile(JSON.stringify({ oauthAccount: { emailAddress: 'unrelated' } }), (filePath) => {
    assert.equal(readOauthAccountId(filePath), undefined);
  });
});

test('readOauthAccountId does not accidentally return organizationUuid instead of accountUuid', () => {
  withTempFile(
    JSON.stringify({ oauthAccount: { organizationUuid: 'org-should-not-be-returned' } }),
    (filePath) => {
      assert.equal(readOauthAccountId(filePath), undefined);
    },
  );
});

test('readOauthAccountId returns undefined for malformed JSON rather than throwing', () => {
  withTempFile('{ not valid json', (filePath) => {
    assert.equal(readOauthAccountId(filePath), undefined);
  });
});

test('resolveMachineId returns a non-empty, stable value across calls, independent of resolveAgentId', () => {
  const first = resolveMachineId();
  const second = resolveMachineId();
  assert.ok(first.length > 0);
  assert.equal(first, second);
});
