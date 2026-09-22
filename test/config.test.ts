import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_HOST, loadConfig } from '../src/config';

// REVA_AGENT_ID is pinned here so every test below is independent of
// whether the machine actually running these tests happens to have a real
// ~/.claude.json — resolveAgentId() has no fallback (see deviceId.ts), so
// without this, these tests would only pass on a machine with a logged-in
// Anthropic account. The dedicated "missing agentId" tests further down
// deliberately omit it instead.
const TOKEN_ENV = { REVA_AUTH_TOKEN: 'auth-token', REVA_AGENT_ID: 'agent-a' };

test('uses the default auth host when REVA_HOST is unset', () => {
  const cfg = loadConfig(TOKEN_ENV);
  assert.equal(cfg.rtgUrl, `https://${DEFAULT_HOST}/pdp/v2/ai/evaluation`);
  assert.equal(cfg.ingestionUrl, `https://${DEFAULT_HOST}/ingestion/v2`);
});

test('REVA_HOST overrides the default host', () => {
  const cfg = loadConfig({
    ...TOKEN_ENV,
    REVA_HOST: 'localhost:8787',
  });
  assert.equal(cfg.rtgUrl, 'http://localhost:8787/pdp/v2/ai/evaluation');
  assert.equal(cfg.ingestionUrl, 'http://localhost:8787/ingestion/v2');
});

test('throws when REVA_AUTH_TOKEN is missing', () => {
  assert.throws(() => loadConfig({}), /REVA_AUTH_TOKEN/);
});

test('a single auth token authenticates both evaluation and ingestion — no separate ingestion token', () => {
  const cfg = loadConfig(TOKEN_ENV);
  assert.equal(cfg.authorization, 'auth-token');
  assert.ok(!('ingestionToken' in cfg));
});

test('reads token from CLAUDE_PLUGIN_OPTION_* when no REVA_AUTH_TOKEN is set', () => {
  const cfg = loadConfig({
    REVA_AGENT_ID: 'agent-a',
    CLAUDE_PLUGIN_OPTION_AUTH_TOKEN: 'from-option-auth',
  });
  assert.equal(cfg.authorization, 'from-option-auth');
  assert.equal(cfg.rtgUrl, `https://${DEFAULT_HOST}/pdp/v2/ai/evaluation`);
});

test('an explicit REVA_* var wins over the CLAUDE_PLUGIN_OPTION_* one when both are set', () => {
  const cfg = loadConfig({
    ...TOKEN_ENV,
    CLAUDE_PLUGIN_OPTION_AUTH_TOKEN: 'from-option',
  });
  assert.equal(cfg.authorization, 'auth-token');
});

test('REVA_HOST uses https for non-local hosts', () => {
  const cfg = loadConfig({
    ...TOKEN_ENV,
    REVA_HOST: 'api.tenant.example.com',
  });
  assert.equal(cfg.rtgUrl, 'https://api.tenant.example.com/pdp/v2/ai/evaluation');
  assert.equal(cfg.ingestionUrl, 'https://api.tenant.example.com/ingestion/v2');
});

test('host comes from the install-dialog option when REVA_HOST is absent', () => {
  const cfg = loadConfig({
    ...TOKEN_ENV,
    CLAUDE_PLUGIN_OPTION_HOST: 'api.example.reva.ai',
  });
  assert.equal(cfg.rtgUrl, 'https://api.example.reva.ai/pdp/v2/ai/evaluation');
});

test('REVA_HOST takes priority over the install-dialog option', () => {
  const cfg = loadConfig({
    ...TOKEN_ENV,
    REVA_HOST: 'api.example.reva.ai',
    CLAUDE_PLUGIN_OPTION_HOST: 'ignored.example.com',
  });
  assert.equal(cfg.rtgUrl, 'https://api.example.reva.ai/pdp/v2/ai/evaluation');
});

test('timeouts still have working defaults — not part of the required/error-if-missing set', () => {
  const cfg = loadConfig(TOKEN_ENV);
  assert.equal(cfg.timeoutMs, 25000);
  assert.equal(cfg.ingestionTimeoutMs, 5000);
});

test('agentId resolves from REVA_AGENT_ID', () => {
  const cfg = loadConfig(TOKEN_ENV);
  assert.equal(cfg.agentId, 'agent-a');
});

test('throws when REVA_AGENT_ID is missing and no Anthropic account is logged in', () => {
  const originalPath = process.env.REVA_CLAUDE_JSON_PATH;
  // Points resolveAgentId()'s underlying readOauthAccountId() at a file
  // that can't exist, so this is deterministic regardless of whether the
  // machine actually running this test has a real ~/.claude.json.
  process.env.REVA_CLAUDE_JSON_PATH = '/nonexistent/reva-governance-test/.claude.json';
  try {
    assert.throws(() => loadConfig({ REVA_AUTH_TOKEN: 'auth-token' }), /REVA_AGENT_ID/);
  } finally {
    if (originalPath === undefined) delete process.env.REVA_CLAUDE_JSON_PATH;
    else process.env.REVA_CLAUDE_JSON_PATH = originalPath;
  }
});
