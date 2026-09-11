import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { resolveUserEmail } from '../src/identity';

function withClaudeJson(content: string | undefined, fn: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-identity-'));
  const filePath = path.join(dir, '.claude.json');
  const previous = process.env.REVA_CLAUDE_JSON_PATH;
  try {
    if (content !== undefined) fs.writeFileSync(filePath, content, 'utf8');
    process.env.REVA_CLAUDE_JSON_PATH = filePath;
    fn(filePath);
  } finally {
    if (previous === undefined) delete process.env.REVA_CLAUDE_JSON_PATH;
    else process.env.REVA_CLAUDE_JSON_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveUserEmail reads oauthAccount.emailAddress from ~/.claude.json', () => {
  withClaudeJson(JSON.stringify({ oauthAccount: { emailAddress: 'oauth@example.com' } }), () => {
    assert.equal(resolveUserEmail(), 'oauth@example.com');
  });
});

test('resolveUserEmail falls back to OS username when oauth email is absent', () => {
  withClaudeJson('{}', () => {
    assert.equal(resolveUserEmail(), os.userInfo().username);
  });
});
