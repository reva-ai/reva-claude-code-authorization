import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  ingestAgent,
  ingestMcpServersFromConfig,
  ingestUser,
  parseMcpListOutput,
  pollMcpServers,
  resolveEntityTypeIds,
} from '../src/ingestionClient';
import { RevaConfig } from '../src/types';

const baseCfg: RevaConfig = {
  pdpUrl: 'https://pdp.test/evaluate',
  authorization: 'eval-token',
  agentId: 'aa-bb-cc-dd-ee-ff',
  timeoutMs: 1000,
  ingestionUrl: 'https://pdp.test/ingestion/v2',
  ingestionTimeoutMs: 1000,
};

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-ingest-'));
  return Promise.resolve(fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// Matches the shape of a real entity-types response, confirmed live — every
// entity type shares schemaName "CodingAgent" (the single Cedar namespace),
// not the "Identity"/"AgenticAI" split originally guessed from the docs.
// resolveEntityTypeIds matches by `name` alone (see its own comment), so
// schemaName here is just realistic fixture data, not something asserted
// on. The unrelated "SubAgent" entry confirms matching-by-name doesn't grab
// the wrong id when other entity types are present in the response.
const entityTypesResponse = [
  { id: 'user-type-id', name: 'User', schemaName: 'CodingAgent' },
  { id: 'agent-type-id', name: 'Agent', schemaName: 'CodingAgent' },
  { id: 'mcp-type-id', name: 'MCPServer', schemaName: 'CodingAgent' },
  { id: 'subagent-type-id', name: 'SubAgent', schemaName: 'CodingAgent' },
];

test('resolveEntityTypeIds fetches and picks the right ids by name alone, including User', async () => {
  await withTempDir(async (dir) => {
    let requestedUrl: string | undefined;
    let headers: Record<string, string> | undefined;
    const ids = await withFetch(
      (async (url: any, opts: any) => {
        requestedUrl = url;
        headers = opts.headers;
        return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );
    assert.equal(ids.userEntityTypeId, 'user-type-id');
    assert.equal(ids.agentEntityTypeId, 'agent-type-id');
    assert.equal(ids.mcpServerEntityTypeId, 'mcp-type-id');
    assert.equal(requestedUrl, 'https://pdp.test/ingestion/v2/policy-store/entity-types');
    assert.equal(headers?.['X-API-Token'], 'eval-token');
  });
});

test('resolveEntityTypeIds caches after the first successful fetch — no second network call', async () => {
  await withTempDir(async (dir) => {
    let fetchCount = 0;
    const fetchOnce = (async () => {
      fetchCount++;
      return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
    }) as any;

    await withFetch(fetchOnce, () => resolveEntityTypeIds(baseCfg, dir));
    assert.equal(fetchCount, 1);

    // Second call should hit the cache, not fetch again — a fetch that
    // throws here would prove the cache wasn't used.
    const second = await withFetch(
      (async () => {
        throw new Error('should not be called — cache should have been used');
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );
    assert.equal(second.agentEntityTypeId, 'agent-type-id');
  });
});

test('resolveEntityTypeIds retries on the next call if MCPServer was missing from an earlier fetch', async () => {
  await withTempDir(async (dir) => {
    let fetchCount = 0;
    // First fetch's response is missing MCPServer entirely (e.g. not yet in
    // the catalog) — Agent resolves fine, but the cache must not be treated
    // as "done" just because that one is present.
    const responseWithoutMcpServer = entityTypesResponse.filter((t) => t.name !== 'MCPServer');

    await withFetch(
      (async () => {
        fetchCount++;
        return new Response(JSON.stringify(responseWithoutMcpServer), { status: 200 });
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );
    assert.equal(fetchCount, 1);

    // A later session, once MCPServer is actually in the catalog, must
    // re-fetch rather than getting stuck on the first, incomplete result.
    const second = await withFetch(
      (async () => {
        fetchCount++;
        return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );
    assert.equal(fetchCount, 2);
    assert.equal(second.mcpServerEntityTypeId, 'mcp-type-id');

    // And now that MCPServer resolved, a third call should finally use the cache.
    const third = await withFetch(
      (async () => {
        throw new Error('should not be called — cache should now be complete');
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );
    assert.equal(third.mcpServerEntityTypeId, 'mcp-type-id');
  });
});

test('resolveEntityTypeIds falls back to cache when a later fetch would fail', async () => {
  await withTempDir(async (dir) => {
    await withFetch(
      (async () => new Response(JSON.stringify(entityTypesResponse), { status: 200 })) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );

    // Cache is warm — a failing network must not throw; return the cached ids.
    const result = await withFetch(
      (async () => {
        throw new Error('ECONNREFUSED');
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir),
    );
    assert.equal(result.agentEntityTypeId, 'agent-type-id');
    assert.equal(result.mcpServerEntityTypeId, 'mcp-type-id');
  });
});

// Every mock fetch below dispatches on opts.method, since ingestUser() makes
// at most 3 calls in one run, all v2: not found -> GET + POST, with
// registeredMachineIds and agents both embedded directly in the create body
// (no follow-up PATCH needed — nothing to accumulate onto yet on a
// brand-new entity); found -> GET + PATCH (registeredMachineIds) + PATCH
// (agents), each on its own (must accumulate onto whatever that existing
// entity already has — one attributeValue per PATCH, so two Sets means two
// calls).
function methodOf(opts: any): string {
  return opts?.method || 'GET';
}

test('ingestUser: GET 404 (not found) creates the User with active, registeredMachineIds AND agents in one POST — no follow-up PATCH', async () => {
  await withTempDir(async () => {
    const calls: { method: string; url: string; body?: any }[] = [];
    await withFetch(
      (async (url: any, opts: any) => {
        const method = methodOf(opts);
        calls.push({ method, url, body: opts?.body ? JSON.parse(opts.body) : undefined });
        if (method === 'GET') return new Response(undefined, { status: 404 });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestUser(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'),
    );

    assert.equal(calls.length, 2); // GET + POST only — no separate PATCH
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, 'https://pdp.test/ingestion/v2/entity/alice%40example.com?entityTypeId=user-type-id');

    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, 'https://pdp.test/ingestion/v2/entity?entityTypeId=user-type-id');
    assert.deepEqual(calls[1].body, {
      entityId: 'alice@example.com',
      attributes: [
        { name: 'active', value: 'false' },
        { name: 'registeredMachineIds', value: 'machine-123' },
        { name: 'agents', value: 'agent-abc' },
      ],
      parents: [],
      children: [],
    });
  });
});

test('ingestUser: GET 400 is also treated as not-found (creates the User), not just 404', async () => {
  await withTempDir(async () => {
    const calls: { method: string }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        const method = methodOf(opts);
        if (method === 'GET') return new Response(undefined, { status: 400 });
        calls.push({ method });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestUser(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'),
    );

    assert.deepEqual(calls, [{ method: 'POST' }]); // POST only — no separate PATCH
  });
});

test('ingestUser: if the create POST itself fails after a confirmed not-found GET, there is no PATCH fallback — self-heals next session', async () => {
  await withTempDir(async () => {
    const calls: { method: string }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        const method = methodOf(opts);
        if (method === 'GET') return new Response(undefined, { status: 404 });
        calls.push({ method });
        return new Response('conflict', { status: 409 });
      }) as any,
      () => ingestUser(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'),
    );
    // No fallback PATCH after a failed create — the next session's GET will
    // find the User still missing and retry the whole POST again.
    assert.deepEqual(calls, [{ method: 'POST' }]);
  });
});

test('ingestUser: GET 200 (already exists) skips creation — PATCHes registeredMachineIds and agents, never touches active', async () => {
  await withTempDir(async () => {
    const calls: { method: string; url: string; body?: any }[] = [];
    await withFetch(
      (async (url: any, opts: any) => {
        const method = methodOf(opts);
        calls.push({ method, url, body: opts?.body ? JSON.parse(opts.body) : undefined });
        if (method === 'GET') {
          return new Response(
            JSON.stringify({
              id: 'entity-1',
              entityType: null,
              source: 'API',
              ownerStoreId: 'store-1',
              entityAttributes: [{ name: 'active', value: 'false' }],
              createdOn: '2026-01-01T00:00:00Z',
              updatedOn: '2026-01-01T00:00:00Z',
              name: 'alice@example.com',
            }),
            { status: 200 },
          );
        }
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestUser(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'),
    );

    assert.equal(calls.length, 3); // GET + PATCH (registeredMachineIds) + PATCH (agents) — no POST
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[1].method, 'PATCH');
    assert.deepEqual(calls[1].body, {
      attributeValue: { name: 'registeredMachineIds', value: 'machine-123' },
      op: 'ADD',
      path: 'ATTRIBUTE',
    });
    assert.equal(calls[2].method, 'PATCH');
    assert.deepEqual(calls[2].body, {
      attributeValue: { name: 'agents', value: 'agent-abc' },
      op: 'ADD',
      path: 'ATTRIBUTE',
    });
    assert.ok(!calls.some((c) => c.body && JSON.stringify(c.body).includes('active')));
  });
});

test('ingestUser: an inconclusive existence check (network failure) skips creation but still attempts both PATCHes', async () => {
  await withTempDir(async () => {
    const calls: { method: string }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        const method = methodOf(opts);
        if (method === 'GET') throw new Error('ECONNREFUSED');
        calls.push({ method });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestUser(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'),
    );

    assert.equal(calls.some((c) => c.method === 'POST'), false);
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 2);
  });
});

test('ingestUser: a real 500 from the existence check is also treated as inconclusive, not "not found"', async () => {
  await withTempDir(async () => {
    const calls: { method: string }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        const method = methodOf(opts);
        if (method === 'GET') return new Response('server error', { status: 500 });
        calls.push({ method });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestUser(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'),
    );

    assert.equal(calls.some((c) => c.method === 'POST'), false);
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 2);
  });
});

test('ingestAgent: GET 404 (not found) creates the Agent with user AND agentType in one POST — no follow-up PATCH', async () => {
  await withTempDir(async () => {
    const calls: { method: string; url: string; body?: any }[] = [];
    await withFetch(
      (async (url: any, opts: any) => {
        const method = methodOf(opts);
        calls.push({ method, url, body: opts?.body ? JSON.parse(opts.body) : undefined });
        if (method === 'GET') return new Response(undefined, { status: 404 });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestAgent(baseCfg, 'agent-type-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com'),
    );

    assert.equal(calls.length, 2); // GET + POST only — no separate PATCH
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, 'https://pdp.test/ingestion/v2/entity/aa-bb-cc-dd-ee-ff?entityTypeId=agent-type-id');

    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, 'https://pdp.test/ingestion/v2/entity?entityTypeId=agent-type-id');
    assert.deepEqual(calls[1].body, {
      entityId: 'aa-bb-cc-dd-ee-ff',
      attributes: [
        { name: 'user', value: 'alice@example.com' },
        { name: 'agentType', value: 'ClaudeCode' },
      ],
      parents: [],
      children: [],
    });
  });
});

test('ingestAgent: GET 200 (already exists) skips creation — only PATCHes agentType', async () => {
  await withTempDir(async () => {
    const calls: { method: string }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        const method = methodOf(opts);
        if (method === 'GET') {
          return new Response(
            JSON.stringify({
              id: 'entity-1',
              entityType: null,
              source: 'API',
              ownerStoreId: 'store-1',
              entityAttributes: [],
              createdOn: '2026-01-01T00:00:00Z',
              updatedOn: '2026-01-01T00:00:00Z',
              name: 'aa-bb-cc-dd-ee-ff',
            }),
            { status: 200 },
          );
        }
        calls.push({ method });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestAgent(baseCfg, 'agent-type-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com'),
    );
    assert.deepEqual(calls, [{ method: 'PATCH' }]); // no POST
  });
});

test('ingestAgent never targets the User entity type — only Agent, across the GET/POST/PATCH it makes', async () => {
  await withTempDir(async () => {
    const entityTypeIdsUsed = new Set<string>();
    await withFetch(
      (async (url: any, opts: any) => {
        const params = new URLSearchParams(url.split('?')[1]);
        entityTypeIdsUsed.add(params.get('entityTypeId') as string);
        if (methodOf(opts) === 'GET') return new Response(undefined, { status: 404 });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestAgent(baseCfg, 'agent-type-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com'),
    );
    assert.deepEqual([...entityTypeIdsUsed], ['agent-type-id']);
  });
});

test('ingestAgent: if the create POST itself fails after a confirmed not-found GET, there is no PATCH fallback — self-heals next session', async () => {
  await withTempDir(async () => {
    const calls: { method: string }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        const method = methodOf(opts);
        if (method === 'GET') return new Response(undefined, { status: 404 });
        calls.push({ method });
        return new Response('already exists', { status: 409 });
      }) as any,
      () => ingestAgent(baseCfg, 'agent-type-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com'),
    );
    // No fallback PATCH after a failed create — the next session's GET will
    // find the Agent (created concurrently, or not) and PATCH from there.
    assert.deepEqual(calls, [{ method: 'POST' }]);
  });
});

test('ingestAgent: an inconclusive existence check skips creation but still attempts the agentType PATCH', async () => {
  await withTempDir(async () => {
    const calls: { method: string }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        const method = methodOf(opts);
        if (method === 'GET') throw new Error('ECONNREFUSED');
        calls.push({ method });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestAgent(baseCfg, 'agent-type-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com'),
    );
    assert.equal(calls.some((c) => c.method === 'POST'), false);
    assert.equal(calls.some((c) => c.method === 'PATCH'), true);
  });
});

test('ingestMcpServersFromConfig only ingests entries with a real url, skips stdio entries', async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'remote-server': { url: 'https://example.com/mcp' },
          'stdio-server': { command: 'npx', args: ['some-mcp-server'] },
        },
      }),
      'utf8',
    );

    const ingested: string[] = [];
    await withFetch(
      (async (url: any, opts: any) => {
        const params = new URLSearchParams(url.split('?')[1]);
        assert.equal(params.get('entityTypeId'), 'mcp-type-id');
        const body = JSON.parse(opts.body);
        ingested.push(body.entityId);
        assert.deepEqual(
          body.attributes.find((a: any) => a.name === 'baseUrl'),
          { name: 'baseUrl', value: 'https://example.com/mcp' },
        );
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestMcpServersFromConfig(baseCfg, 'mcp-type-id', dir),
    );

    assert.deepEqual(ingested, ['remote-server']);
  });
});

test('ingestMcpServersFromConfig does nothing (and does not throw) when .mcp.json is missing', async () => {
  await withTempDir(async (dir) => {
    let called = false;
    await withFetch(
      (async () => {
        called = true;
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestMcpServersFromConfig(baseCfg, 'mcp-type-id', dir),
    );
    assert.equal(called, false);
  });
});

test('ingestMcpServersFromConfig does nothing when .mcp.json is malformed JSON', async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{ not valid json', 'utf8');
    let called = false;
    await withFetch(
      (async () => {
        called = true;
        return new Response(undefined, { status: 200 });
      }) as any,
      () => ingestMcpServersFromConfig(baseCfg, 'mcp-type-id', dir),
    );
    assert.equal(called, false);
  });
});

// Real sample from `claude mcp list` output, pasted by the user — the
// claude.ai connectors (ElevenLabs, Unsplash, Google Drive/Gmail/Calendar)
// never appear in ~/.claude.json at all, confirmed live, so this CLI output
// is the only way to see them.
const REAL_MCP_LIST_OUTPUT = `Checking MCP server health…

claude.ai ElevenLabs: https://api.elevenlabs.io/v1/mcp - ✔ Connected
claude.ai Unsplash: https://mcp.unsplash.com/mcp - ! Needs authentication
claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ✔ Connected
plugin:context7:context7: https://mcp.context7.com/mcp (HTTP) - ✔ Connected
`;

test('parseMcpListOutput parses every real connector line, skipping the banner and blank lines', () => {
  const entries = parseMcpListOutput(REAL_MCP_LIST_OUTPUT);
  assert.deepEqual(entries, [
    { name: 'claude.ai ElevenLabs', url: 'https://api.elevenlabs.io/v1/mcp' },
    { name: 'claude.ai Unsplash', url: 'https://mcp.unsplash.com/mcp' },
    { name: 'claude.ai Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1' },
    { name: 'claude.ai Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
    { name: 'claude.ai Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1' },
    { name: 'plugin:context7:context7', url: 'https://mcp.context7.com/mcp' },
  ]);
});

test('parseMcpListOutput treats a non-URL second token as local/stdio — url left undefined, never fabricated', () => {
  // Real stdio-server line shape is unconfirmed (none configured on the
  // machine this was written on) — this only exercises the parser's actual
  // decision rule: no http(s):// prefix means nothing honest to ingest.
  const entries = parseMcpListOutput('my-local-server: node - ✔ Connected\n');
  assert.deepEqual(entries, [{ name: 'my-local-server', url: undefined }]);
});

test('parseMcpListOutput returns nothing for empty or banner-only output', () => {
  assert.deepEqual(parseMcpListOutput(''), []);
  assert.deepEqual(parseMcpListOutput('Checking MCP server health…\n'), []);
});

test('pollMcpServers ingests every new connector on first run, then skips entirely once due-time has not elapsed', async () => {
  await withTempDir(async (dir) => {
    const posted: { entityId: string; body: any }[] = [];
    await withFetch(
      (async (url: any, opts: any) => {
        posted.push({ entityId: JSON.parse(opts.body).entityId, body: JSON.parse(opts.body) });
        return new Response(undefined, { status: 200 });
      }) as any,
      () => pollMcpServers(baseCfg, 'mcp-type-id', dir, () => REAL_MCP_LIST_OUTPUT),
    );

    // Only the 6 real connectors, all url-bearing — none skipped.
    assert.equal(posted.length, 6);
    assert.deepEqual(posted[0].body, {
      entityId: 'claude.ai ElevenLabs',
      attributes: [
        { name: 'description', value: 'MCP server "claude.ai ElevenLabs"' },
        { name: 'transport', value: 'http' },
        { name: 'baseUrl', value: 'https://api.elevenlabs.io/v1/mcp' },
        { name: 'connectionType', value: 'remote' },
      ],
      parents: [],
      children: [],
    });

    // Second call, immediately after — not due for another ~4h, so the CLI
    // must not be invoked again (a throw here would prove it was).
    await pollMcpServers(baseCfg, 'mcp-type-id', dir, () => {
      throw new Error('should not be called — poll should not be due yet');
    });
  });
});

test('pollMcpServers only ingests names not already known, on a later poll once due', async () => {
  await withTempDir(async (dir) => {
    // Prime the cache as if ElevenLabs was already ingested, and force the
    // throttle open by writing a stale lastMcpServersPolledAt directly.
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({ lastMcpServersPolledAt: 0, knownMcpServerNames: ['claude.ai ElevenLabs'] }),
      'utf8',
    );

    const posted: string[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        posted.push(JSON.parse(opts.body).entityId);
        return new Response(undefined, { status: 200 });
      }) as any,
      () => pollMcpServers(baseCfg, 'mcp-type-id', dir, () => REAL_MCP_LIST_OUTPUT),
    );

    assert.equal(posted.includes('claude.ai ElevenLabs'), false);
    assert.equal(posted.length, 5);
  });
});

test('pollMcpServers leaves a failed ingest out of knownMcpServerNames so the next poll retries it', async () => {
  await withTempDir(async (dir) => {
    await withFetch(
      (async () => new Response('server error', { status: 500 })) as any,
      () => pollMcpServers(baseCfg, 'mcp-type-id', dir, () => 'flaky-server: https://flaky.example.com/mcp - ✔ Connected\n'),
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.equal(cache.knownMcpServerNames.includes('flaky-server'), false);
    // lastMcpServersPolledAt still updates — a poll happened, even though
    // every ingest in it failed — so this doesn't retry on every session.
    assert.ok(typeof cache.lastMcpServersPolledAt === 'number');
  });
});

test('pollMcpServers marks a local/stdio entry (no URL) as known immediately — nothing to retry', async () => {
  await withTempDir(async (dir) => {
    let fetchCalled = false;
    await withFetch(
      (async () => {
        fetchCalled = true;
        return new Response(undefined, { status: 200 });
      }) as any,
      () => pollMcpServers(baseCfg, 'mcp-type-id', dir, () => 'my-local-server: node - ✔ Connected\n'),
    );

    assert.equal(fetchCalled, false);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.deepEqual(cache.knownMcpServerNames, ['my-local-server']);
  });
});

test('pollMcpServers does not throw when `claude mcp list` itself fails to run', async () => {
  await withTempDir(async (dir) => {
    await pollMcpServers(baseCfg, 'mcp-type-id', dir, () => {
      throw new Error('ENOENT: claude not found');
    });
    // No cache file at all — the throttle timestamp is only written after a
    // successful listMcpServers() call, so this correctly retries next time.
    assert.equal(fs.existsSync(path.join(dir, 'entity-types', 'catalog.json')), false);
  });
});

test('with no pluginDataDir, nothing persists — no fallback to a home-directory dotfile', async () => {
  const homeRevaGovernance = path.join(os.homedir(), '.reva-governance');
  const existedBefore = fs.existsSync(homeRevaGovernance);

  // ingestUser()/ingestAgent() have no local cache at all anymore — their
  // GET existence check is the live source of truth every time, with or
  // without a pluginDataDir — so there's nothing to test for either of
  // them here. Only resolveEntityTypeIds() still has a local cache.
  let fetchCount = 0;
  const fetchImpl = (async () => {
    fetchCount++;
    return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
  }) as any;

  const first = await withFetch(fetchImpl, () => resolveEntityTypeIds(baseCfg, undefined));
  assert.equal(first.agentEntityTypeId, 'agent-type-id'); // still resolves for this call...
  const second = await withFetch(fetchImpl, () => resolveEntityTypeIds(baseCfg, undefined));
  assert.equal(second.agentEntityTypeId, 'agent-type-id');
  // ...but a genuine second network fetch happened — nothing was cached
  // without a pluginDataDir to cache it in.
  assert.equal(fetchCount, 2);

  assert.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});
