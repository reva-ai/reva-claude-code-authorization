import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { debugLog } from '../src/debug';

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const original: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    original[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(original)) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
}

function captureStderr<T>(fn: () => T): { result: T; written: string[] } {
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr.write as any) = (chunk: any) => {
    written.push(String(chunk));
    return true;
  };
  try {
    return { result: fn(), written };
  } finally {
    process.stderr.write = original;
  }
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-debug-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('debugLog writes nothing at all when REVA_DEBUG is unset', () => {
  withTempDir((dir) => {
    withEnv({ REVA_DEBUG: undefined, CLAUDE_PLUGIN_DATA: dir }, () => {
      const { written } = captureStderr(() => debugLog('should not appear'));
      assert.deepEqual(written, []);
      assert.equal(fs.existsSync(path.join(dir, 'debug.log')), false);
    });
  });
});

test('debugLog writes to stderr, unprefixed by timestamp, when REVA_DEBUG is set', () => {
  withEnv({ REVA_DEBUG: '1', CLAUDE_PLUGIN_DATA: undefined }, () => {
    const { written } = captureStderr(() => debugLog('hello'));
    assert.deepEqual(written, ['[reva-security] hello\n']);
  });
});

test('debugLog also appends a timestamped line to CLAUDE_PLUGIN_DATA/debug.log when both are set', () => {
  withTempDir((dir) => {
    withEnv({ REVA_DEBUG: '1', CLAUDE_PLUGIN_DATA: dir }, () => {
      captureStderr(() => debugLog('hello'));
    });
    const content = fs.readFileSync(path.join(dir, 'debug.log'), 'utf8');
    assert.match(content, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] hello\n$/);
  });
});

test('debugLog appends across multiple calls rather than overwriting', () => {
  withTempDir((dir) => {
    withEnv({ REVA_DEBUG: '1', CLAUDE_PLUGIN_DATA: dir }, () => {
      captureStderr(() => {
        debugLog('first');
        debugLog('second');
      });
    });
    const content = fs.readFileSync(path.join(dir, 'debug.log'), 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /first$/);
    assert.match(lines[1], /second$/);
  });
});

test('debugLog with REVA_DEBUG set but no CLAUDE_PLUGIN_DATA: stderr only, no file, no throw', () => {
  withEnv({ REVA_DEBUG: '1', CLAUDE_PLUGIN_DATA: undefined }, () => {
    const { written } = captureStderr(() => debugLog('no plugin data dir'));
    assert.deepEqual(written, ['[reva-security] no plugin data dir\n']);
  });
});

test('debugLog never throws even when CLAUDE_PLUGIN_DATA points somewhere unwritable', () => {
  withEnv({ REVA_DEBUG: '1', CLAUDE_PLUGIN_DATA: '/nonexistent-root/reva-governance-debug-test' }, () => {
    assert.doesNotThrow(() => captureStderr(() => debugLog('should not throw')));
  });
});
