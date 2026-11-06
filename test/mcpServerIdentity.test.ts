import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  isMcpServerUuid,
  loadMcpServerIdentityCache,
  readDesktopConnectors,
  refreshMcpServerIdentityCache,
  resolveMcpServerIdentity,
  slugifyMcpServerName,
} from '../src/mcpServerIdentity';

function withTempDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-mcp-identity-'));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
}

async function withSessionsDir<T>(sessionsDir: string, fn: () => Promise<T> | T): Promise<T> {
  const original = process.env.REVA_CLAUDE_SESSIONS_DIR;
  process.env.REVA_CLAUDE_SESSIONS_DIR = sessionsDir;
  try {
    return await fn();
  } finally {
    if (original === undefined) delete process.env.REVA_CLAUDE_SESSIONS_DIR;
    else process.env.REVA_CLAUDE_SESSIONS_DIR = original;
  }
}

function writeDesktopSession(
  sessionsDir: string,
  connectors: unknown[],
  file = 'local_desktop-session-1.json',
  account = 'account-1',
  org = 'org-1',
): void {
  writeJson(path.join(sessionsDir, account, org, file), { remoteMcpServersConfig: connectors });
}

test('slugifies the real display names this machine actually has', () => {
  // These are real claude.ai connector display names — the whole point of
  // the slug is that "Google Calendar" here produces the same id discovery
  // produces from "claude.ai Google Calendar".
  assert.equal(slugifyMcpServerName('Gmail'), 'gmail');
  assert.equal(slugifyMcpServerName('Google Calendar'), 'google-calendar');
  assert.equal(slugifyMcpServerName('Google Drive'), 'google-drive');
  assert.equal(slugifyMcpServerName('Claude Docs'), 'claude-docs');
  assert.equal(slugifyMcpServerName('ElevenLabs'), 'elevenlabs');
  assert.equal(slugifyMcpServerName('Miro'), 'miro');
});

test('strips the two claude.ai prefixes that exist in real data, so both spellings converge', () => {
  assert.equal(slugifyMcpServerName('claude.ai Gmail'), 'gmail');
  assert.equal(slugifyMcpServerName('claude.ai Google Drive'), 'google-drive');
  assert.equal(slugifyMcpServerName('claude_ai_Google_Calendar'), 'google-calendar');
  // The convergence itself, stated directly: this is the join that was
  // broken before — inventory said one thing, enforcement said another.
  assert.equal(slugifyMcpServerName('claude.ai Google Calendar'), slugifyMcpServerName('Google Calendar'));
});

test('does not truncate a server whose name merely starts with something claude-ish', () => {
  // Deliberately NOT a loose /claude.?ai/ match — "claude-ai-proxy" is a
  // real name, not a prefixed one.
  assert.equal(slugifyMcpServerName('claude-ai-proxy'), 'claude-ai-proxy');
  assert.equal(slugifyMcpServerName('claudeai'), 'claudeai');
});

test('normalizes separators, case, and stray punctuation', () => {
  assert.equal(slugifyMcpServerName('My_Server'), 'my-server');
  assert.equal(slugifyMcpServerName('My  Server'), 'my-server');
  assert.equal(slugifyMcpServerName('some.dotted.name'), 'some-dotted-name');
  assert.equal(slugifyMcpServerName('  Padded  '), 'padded');
  assert.equal(slugifyMcpServerName('already-a-slug'), 'already-a-slug');
});

test('a name that is nothing but the prefix keeps its original rather than slugging to empty', () => {
  assert.equal(slugifyMcpServerName('claude.ai '), 'claude-ai');
  assert.notEqual(slugifyMcpServerName('claude.ai '), '');
});

test('recognizes a connector uuid, and does not mistake an ordinary name for one', () => {
  assert.equal(isMcpServerUuid('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'), true);
  assert.equal(isMcpServerUuid('AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA'), true);
  assert.equal(isMcpServerUuid('computer-use'), false);
  assert.equal(isMcpServerUuid('plugin_context7_context7'), false);
  assert.equal(isMcpServerUuid('aaaaaaaa-1111-4111-8111'), false);
});

test('reads connectors out of the desktop app session files, newest file winning on a repeat', async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = path.join(dir, 'sessions');
    writeDesktopSession(sessionsDir, [
      { uuid: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
    ]);

    await withSessionsDir(sessionsDir, () => {
      const connectors = readDesktopConnectors();
      assert.deepEqual(connectors, [
        { uuid: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
      ]);
    });
  });
});

test('a missing sessions directory yields nothing rather than throwing — the normal non-macOS case', async () => {
  await withTempDir(async (dir) => {
    await withSessionsDir(path.join(dir, 'does-not-exist'), () => {
      assert.deepEqual(readDesktopConnectors(), []);
    });
  });
});

test('resolves a uuid to its slug through the cache, and caches display name and url alongside', async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = path.join(dir, 'sessions');
    const pluginDataDir = path.join(dir, 'plugin-data');
    writeDesktopSession(sessionsDir, [
      { uuid: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', name: 'Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1' },
    ]);

    await withSessionsDir(sessionsDir, () => {
      refreshMcpServerIdentityCache(pluginDataDir);
      const identity = resolveMcpServerIdentity('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', pluginDataDir);
      assert.equal(identity.slug, 'google-calendar');
      assert.equal(identity.displayName, 'Google Calendar');
      assert.equal(identity.url, 'https://calendarmcp.googleapis.com/mcp/v1');
    });
  });
});

test('an unknown uuid resolves to itself — never a fabricated slug', async () => {
  await withTempDir(async (dir) => {
    const pluginDataDir = path.join(dir, 'plugin-data');
    // Nothing cached at all: a uuid carries no name, so there is nothing
    // honest to derive. An opaque-but-true id beats a guessed one in an
    // audit trail.
    const identity = resolveMcpServerIdentity('11111111-2222-3333-4444-555555555555', pluginDataDir);
    assert.equal(identity.slug, '11111111-2222-3333-4444-555555555555');
    assert.equal(identity.displayName, undefined);
  });
});

test('a non-uuid token is slugged, into the same format every source uses', async () => {
  await withTempDir(async (dir) => {
    const pluginDataDir = path.join(dir, 'plugin-data');
    // The app-provided servers exist in no config file, so a tool name is the
    // only evidence they exist — these are exactly the ids ingest-on-invoke
    // records for them.
    assert.equal(resolveMcpServerIdentity('Claude_Browser', pluginDataDir).slug, 'claude-browser');
    assert.equal(resolveMcpServerIdentity('claude-in-chrome', pluginDataDir).slug, 'claude-in-chrome');
    assert.equal(resolveMcpServerIdentity('Claude_Code_iOS_Simulator', pluginDataDir).slug, 'claude-code-ios-simulator');
    assert.equal(resolveMcpServerIdentity('computer-use', pluginDataDir).slug, 'computer-use');
    assert.equal(resolveMcpServerIdentity('plugin_context7_context7', pluginDataDir).slug, 'plugin-context7-context7');
  });
});

test('refreshMcpServerIdentityCache merges discovered (non-uuid) servers by slug, and resolveMcpServerIdentity picks up their url', async () => {
  await withTempDir(async (dir) => {
    const pluginDataDir = path.join(dir, 'plugin-data');
    refreshMcpServerIdentityCache(pluginDataDir, [
      { name: 'my-http-server', url: 'https://my-http-server.example.com/mcp', displayName: 'My HTTP Server' },
    ]);
    const identity = resolveMcpServerIdentity('my-http-server', pluginDataDir);
    assert.equal(identity.slug, 'my-http-server');
    assert.equal(identity.url, 'https://my-http-server.example.com/mcp');
    assert.equal(identity.displayName, 'My HTTP Server');
  });
});

test('a discovered server with no url is still cached, so resolution is definitive rather than ambiguous', async () => {
  await withTempDir(async (dir) => {
    const pluginDataDir = path.join(dir, 'plugin-data');
    refreshMcpServerIdentityCache(pluginDataDir, [{ name: 'my-stdio-server', url: undefined }]);
    const identity = resolveMcpServerIdentity('my-stdio-server', pluginDataDir);
    assert.equal(identity.slug, 'my-stdio-server');
    assert.equal(identity.url, undefined);
  });
});

test('an app-provided server never discovered by any file source still falls back to {slug}, no url', async () => {
  await withTempDir(async (dir) => {
    const pluginDataDir = path.join(dir, 'plugin-data');
    // Nothing discovers claude-browser — it's never in a config file — so
    // the identity cache has no entry for it either way.
    refreshMcpServerIdentityCache(pluginDataDir, []);
    const identity = resolveMcpServerIdentity('Claude_Browser', pluginDataDir);
    assert.deepEqual(identity, { slug: 'claude-browser' });
  });
});

test('slugging is many-to-one, and that collapse is symmetric', async () => {
  await withTempDir(async (dir) => {
    const pluginDataDir = path.join(dir, 'plugin-data');
    // "my_server" and "my-server" land on one id. Accepted cost of a single
    // uniform format — and harmless for the join, because discovery collapses
    // them identically, so no tool call is ever orphaned.
    const a = resolveMcpServerIdentity('my_server', pluginDataDir).slug;
    const b = resolveMcpServerIdentity('my-server', pluginDataDir).slug;
    const c = resolveMcpServerIdentity('My.Server', pluginDataDir).slug;
    assert.equal(a, 'my-server');
    assert.equal(b, 'my-server');
    assert.equal(c, 'my-server');
  });
});

test('the cache is MERGED on refresh, so a disconnected connector keeps resolving to its real name', async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = path.join(dir, 'sessions');
    const pluginDataDir = path.join(dir, 'plugin-data');

    writeDesktopSession(sessionsDir, [
      { uuid: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
    ]);
    await withSessionsDir(sessionsDir, () => refreshMcpServerIdentityCache(pluginDataDir));

    // Gmail is gone from the session files entirely on the next pass.
    writeDesktopSession(sessionsDir, [
      { uuid: 'dddddddd-4444-4444-8444-dddddddddddd', name: 'Miro', url: 'https://mcp.miro.com' },
    ]);
    await withSessionsDir(sessionsDir, () => refreshMcpServerIdentityCache(pluginDataDir));

    // A tool call from a now-disconnected connector must still be
    // attributable — reverting it to a raw uuid would quietly corrupt the
    // audit trail for history that was already recorded under "gmail".
    assert.equal(resolveMcpServerIdentity('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', pluginDataDir).slug, 'gmail');
    assert.equal(resolveMcpServerIdentity('dddddddd-4444-4444-8444-dddddddddddd', pluginDataDir).slug, 'miro');
  });
});

test('a corrupt or absent cache degrades to the raw token instead of throwing', async () => {
  await withTempDir(async (dir) => {
    const pluginDataDir = path.join(dir, 'plugin-data');
    fs.mkdirSync(pluginDataDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDataDir, 'mcp-server-identity.json'), '{ not valid json', 'utf8');

    // This runs on the PreToolUse path, where authorize.ts fails CLOSED —
    // a throw here would deny a legitimate tool call.
    assert.deepEqual(loadMcpServerIdentityCache(pluginDataDir), {});
    assert.equal(
      resolveMcpServerIdentity('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', pluginDataDir).slug,
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    );
    assert.equal(resolveMcpServerIdentity('computer-use', pluginDataDir).slug, 'computer-use');
  });
});

test('no pluginDataDir at all is survivable — nothing is written, resolution still answers', async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = path.join(dir, 'sessions');
    writeDesktopSession(sessionsDir, [
      { uuid: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
    ]);

    await withSessionsDir(sessionsDir, () => {
      const map = refreshMcpServerIdentityCache(undefined);
      assert.equal(map['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'].slug, 'gmail');
      // Nothing persisted, so a later resolve falls back rather than lying.
      assert.equal(
        resolveMcpServerIdentity('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', undefined).slug,
        'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      );
    });
  });
});

test('a uuid resolves case-insensitively — one connector can never land under two ids', async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = path.join(dir, 'sessions');
    const pluginDataDir = path.join(dir, 'plugin-data');
    writeDesktopSession(sessionsDir, [
      { uuid: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
    ]);

    await withSessionsDir(sessionsDir, () => {
      refreshMcpServerIdentityCache(pluginDataDir);
      assert.equal(resolveMcpServerIdentity('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', pluginDataDir).slug, 'gmail');
      // isMcpServerUuid accepts either case, so an uppercase spelling must
      // not miss the cache and fall through to a raw uppercase id.
      assert.equal(resolveMcpServerIdentity('AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA', pluginDataDir).slug, 'gmail');
    });
  });
});

test('an unresolvable uuid is normalized even in the fallback', async () => {
  await withTempDir(async (dir) => {
    const pluginDataDir = path.join(dir, 'plugin-data');
    // Both spellings must produce the SAME opaque id, or the audit trail
    // splits one unknown server into two.
    assert.equal(
      resolveMcpServerIdentity('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', pluginDataDir).slug,
      resolveMcpServerIdentity('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', pluginDataDir).slug,
    );
    assert.equal(
      resolveMcpServerIdentity('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', pluginDataDir).slug,
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    );
  });
});
