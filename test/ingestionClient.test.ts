import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  ingestAgent,
  ingestDiscoveredMcpServers,
  ingestUser,
  isMcpDiscoveryDue,
  recordMcpDiscoveryTriggered,
  resolveEntityTypeIds,
} from '../src/ingestionClient';
import { DiscoveredMcpServer } from '../src/mcpDiscovery';
import { RevaConfig } from '../src/types';

const baseCfg: RevaConfig = {
  rtgUrl: 'https://rtg.test/evaluate',
  authorization: 'eval-token',
  agentId: 'aa-bb-cc-dd-ee-ff',
  timeoutMs: 1000,
  ingestionUrl: 'https://rtg.test/ingestion/v2',
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

// Matches a real entity-types response, confirmed live — every
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
    assert.equal(requestedUrl, 'https://rtg.test/ingestion/v2/policy-store/entity-types');
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

test('resolveEntityTypeIds(forceRefresh=true) re-fetches and replaces the cache even when it was already complete', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      // A fully "complete" cache — the plain (non-forced) path would trust
      // this and never call fetch at all.
      JSON.stringify({ userEntityTypeId: 'old-user-id', agentEntityTypeId: 'old-agent-id', mcpServerEntityTypeId: 'old-mcp-id' }),
      'utf8',
    );

    let fetchCount = 0;
    const result = await withFetch(
      (async () => {
        fetchCount++;
        return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
      }) as any,
      () => resolveEntityTypeIds(baseCfg, dir, true),
    );

    assert.equal(fetchCount, 1); // fetched despite a complete cache being present
    assert.equal(result.userEntityTypeId, 'user-type-id'); // the fresh id, not the old cached one
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.equal(cache.userEntityTypeId, 'user-type-id'); // replaced on disk too, not just the return value
  });
});

test('resolveEntityTypeIds(forceRefresh=true) falls back to the old cache if the forced fetch itself fails', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({ userEntityTypeId: 'old-user-id', agentEntityTypeId: 'old-agent-id', mcpServerEntityTypeId: 'old-mcp-id' }),
      'utf8',
    );

    const result = await withFetch(
      (async () => new Response('server error', { status: 500 })) as any,
      () => resolveEntityTypeIds(baseCfg, dir, true),
    );

    // Best-effort: a failed forced refresh degrades to the old (possibly
    // stale) cache rather than leaving the session with nothing at all.
    assert.equal(result.userEntityTypeId, 'old-user-id');
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
    assert.equal(calls[0].url, 'https://rtg.test/ingestion/v2/entity/alice%40example.com?entityTypeId=user-type-id');

    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, 'https://rtg.test/ingestion/v2/entity?entityTypeId=user-type-id');
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

test('ingestUser: a POST failing with "Entity type not found" resets the whole local ingestion cache, not just the entity-type ids', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({
        userEntityTypeId: 'stale-user-id',
        agentEntityTypeId: 'stale-agent-id',
        mcpServerEntityTypeId: 'stale-mcp-id',
        knownMcpServerNames: ['claude.ai Gmail'],
        lastMcpDiscoveryTriggeredAt: Date.now(),
      }),
      'utf8',
    );

    await withFetch(
      (async (_url: any, opts: any) => {
        if (methodOf(opts) === 'GET') return new Response(undefined, { status: 404 });
        return new Response(
          JSON.stringify({ key: 'RESOURCE.NOT.FOUND', message: 'Entity type not found', data: 'stale-user-id' }),
          { status: 404 },
        );
      }) as any,
      () => ingestUser(baseCfg, 'stale-user-id', 'alice@example.com', 'machine-123', 'agent-abc', dir),
    );

    // Confirmed live: a policy-store migration that reassigns entity-type
    // ids also leaves the real entities empty under the new ones, so
    // knownMcpServerNames is just as stale as the ids themselves — a
    // server marked "known" here may not actually be registered anymore.
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.equal(cache.userEntityTypeId, undefined);
    assert.equal(cache.agentEntityTypeId, undefined);
    assert.equal(cache.mcpServerEntityTypeId, undefined);
    assert.equal(cache.knownMcpServerNames, undefined);
    assert.equal(cache.lastMcpDiscoveryTriggeredAt, undefined);
  });
});

// This is the actual recovery behavior confirmed live: not just "the cache
// gets cleared for next time" (the test above), but a successful retry
// within this SAME call, once a fresh id is available.
test('ingestUser: a POST failing with "Entity type not found" retries once, within the same call, using a freshly-resolved id', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({ userEntityTypeId: 'stale-user-id', agentEntityTypeId: 'stale-agent-id', mcpServerEntityTypeId: 'stale-mcp-id' }),
      'utf8',
    );

    const postEntityTypeIdsUsed: string[] = [];
    await withFetch(
      (async (url: any, opts: any) => {
        if (url.includes('/policy-store/entity-types')) {
          return new Response(JSON.stringify(entityTypesResponse), { status: 200 }); // the real, current ids
        }
        if (methodOf(opts) === 'GET') return new Response(undefined, { status: 404 }); // existence check: not found -> POST
        const entityTypeId = new URLSearchParams(url.split('?')[1]).get('entityTypeId');
        postEntityTypeIdsUsed.push(entityTypeId!);
        if (entityTypeId === 'stale-user-id') {
          return new Response(
            JSON.stringify({ key: 'RESOURCE.NOT.FOUND', message: 'Entity type not found', data: 'stale-user-id' }),
            { status: 404 },
          );
        }
        return new Response(undefined, { status: 201 }); // the retry, with the fresh id, succeeds
      }) as any,
      () => ingestUser(baseCfg, 'stale-user-id', 'alice@example.com', 'machine-123', 'agent-abc', dir),
    );

    // First attempt used the stale id and failed; the retry used the
    // freshly-resolved id (from entityTypesResponse) and succeeded — both
    // within this one ingestUser() call, not a second separate invocation.
    assert.deepEqual(postEntityTypeIdsUsed, ['stale-user-id', 'user-type-id']);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.equal(cache.userEntityTypeId, 'user-type-id'); // cache now holds the fresh id — not cleared, not still stale
  });
});

test('ingestUser: a POST failing for an unrelated reason does not invalidate the entity-type cache', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({ userEntityTypeId: 'real-user-id', agentEntityTypeId: 'real-agent-id', mcpServerEntityTypeId: 'real-mcp-id' }),
      'utf8',
    );

    await withFetch(
      (async (_url: any, opts: any) => {
        if (methodOf(opts) === 'GET') return new Response(undefined, { status: 404 });
        return new Response('conflict', { status: 409 });
      }) as any,
      () => ingestUser(baseCfg, 'real-user-id', 'alice@example.com', 'machine-123', 'agent-abc', dir),
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.equal(cache.userEntityTypeId, 'real-user-id'); // untouched — a 409 isn't a stale-id signal
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
    assert.equal(calls[0].url, 'https://rtg.test/ingestion/v2/entity/aa-bb-cc-dd-ee-ff?entityTypeId=agent-type-id');

    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, 'https://rtg.test/ingestion/v2/entity?entityTypeId=agent-type-id');
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

test('ingestAgent: a POST failing with "Entity type not found" invalidates the cached entity-type ids too', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({ userEntityTypeId: 'stale-user-id', agentEntityTypeId: 'stale-agent-id', mcpServerEntityTypeId: 'stale-mcp-id' }),
      'utf8',
    );

    await withFetch(
      (async (_url: any, opts: any) => {
        if (methodOf(opts) === 'GET') return new Response(undefined, { status: 404 });
        return new Response(
          JSON.stringify({ key: 'RESOURCE.NOT.FOUND', message: 'Entity type not found', data: 'stale-agent-id' }),
          { status: 404 },
        );
      }) as any,
      () => ingestAgent(baseCfg, 'stale-agent-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com', dir),
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.equal(cache.userEntityTypeId, undefined);
    assert.equal(cache.agentEntityTypeId, undefined);
    assert.equal(cache.mcpServerEntityTypeId, undefined);
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

// ingestDiscoveredMcpServers takes an injectable `discover` function in
// place of the old raw-CLI-string-to-parse callback — mcpDiscovery.ts's own
// tests cover turning real files into DiscoveredMcpServer[]; these only
// exercise what happens with that list once discovered.
function discovering(entries: DiscoveredMcpServer[]): (cwd: string) => DiscoveredMcpServer[] {
  return () => entries;
}

test('ingestDiscoveredMcpServers ingests every newly-discovered remote server in one bulk POST, skips stdio (no url) entries', async () => {
  await withTempDir(async (dir) => {
    let body: any;
    await withFetch(
      (async (url: any, opts: any) => {
        const params = new URLSearchParams(url.split('?')[1]);
        assert.equal(params.get('entityTypeId'), 'mcp-type-id');
        assert.ok(url.includes('/entity/bulk'));
        body = JSON.parse(opts.body);
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          dir,
          dir,
          undefined,
          undefined,
          discovering([
            { name: 'remote-server', url: 'https://example.com/mcp' },
            { name: 'stdio-server', url: undefined },
          ]),
        ),
    );

    assert.equal(body.length, 1);
    assert.equal(body[0].entityId, 'remote-server');
    assert.deepEqual(
      body[0].attributes.find((a: any) => a.name === 'baseUrl'),
      { name: 'baseUrl', value: 'https://example.com/mcp' },
    );
  });
});

test('ingestDiscoveredMcpServers bundles several newly-discovered remote servers into one bulk POST, not one call each', async () => {
  await withTempDir(async (dir) => {
    let callCount = 0;
    let body: any;
    await withFetch(
      (async (_url: any, opts: any) => {
        callCount += 1;
        body = JSON.parse(opts.body);
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          dir,
          dir,
          undefined,
          undefined,
          discovering([
            { name: 'server-a', url: 'https://a.example.com/mcp' },
            { name: 'server-b', url: 'https://b.example.com/mcp' },
            { name: 'server-c', url: 'https://c.example.com/mcp' },
          ]),
        ),
    );

    assert.equal(callCount, 1); // one HTTP call, not three
    assert.deepEqual(
      body.map((e: any) => e.entityId),
      ['server-a', 'server-b', 'server-c'],
    );
  });
});

test('ingestDiscoveredMcpServers: a failed bulk POST holds back known-marking for every entry in that batch, not just one', async () => {
  await withTempDir(async (dir) => {
    await withFetch(
      (async () => new Response('server error', { status: 500 })) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          dir,
          dir,
          undefined,
          undefined,
          discovering([
            { name: 'server-a', url: 'https://a.example.com/mcp' },
            { name: 'server-b', url: 'https://b.example.com/mcp' },
          ]),
        ),
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.deepEqual(cache.knownMcpServerNames, []); // neither retried individually — the whole batch retries next session
  });
});

// This is the actual failure mode confirmed live: a policy-store/tenant
// migration reassigns entity-type ids server-side, the plugin's cache still
// holds the old ones, and every ingestion call starts failing with this
// exact 404 shape until something invalidates the cache.
test('ingestDiscoveredMcpServers: a bulk PATCH failing with "Entity type not found" invalidates the cached entity-type ids', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({
        userEntityTypeId: 'stale-user-id',
        agentEntityTypeId: 'stale-agent-id',
        mcpServerEntityTypeId: 'stale-mcp-id',
      }),
      'utf8',
    );

    await withFetch(
      (async () =>
        new Response(
          JSON.stringify({ key: 'RESOURCE.NOT.FOUND', message: 'Entity type not found', data: 'stale-user-id' }),
          { status: 404 },
        )) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'stale-mcp-id',
          dir,
          dir,
          'stale-user-id',
          'alice@example.com',
          discovering([{ name: 'my-local-server', url: undefined }]),
        ),
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.equal(cache.userEntityTypeId, undefined);
    assert.equal(cache.agentEntityTypeId, undefined);
    assert.equal(cache.mcpServerEntityTypeId, undefined);
  });
});

test('ingestDiscoveredMcpServers: a bulk MCPServer POST failing with "Entity type not found" retries once, within the same call, and the server ends up known', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({ userEntityTypeId: 'user-type-id', agentEntityTypeId: 'agent-type-id', mcpServerEntityTypeId: 'stale-mcp-id' }),
      'utf8',
    );

    const postEntityTypeIdsUsed: string[] = [];
    await withFetch(
      (async (url: any, opts: any) => {
        if (url.includes('/policy-store/entity-types')) {
          return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
        }
        if (methodOf(opts) === 'PATCH') return new Response(undefined, { status: 200 }); // registeredMcpServers, unrelated to this test
        const entityTypeId = new URLSearchParams(url.split('?')[1]).get('entityTypeId');
        postEntityTypeIdsUsed.push(entityTypeId!);
        if (entityTypeId === 'stale-mcp-id') {
          return new Response(
            JSON.stringify({ key: 'RESOURCE.NOT.FOUND', message: 'Entity type not found', data: 'stale-mcp-id' }),
            { status: 404 },
          );
        }
        return new Response(undefined, { status: 201 }); // the retry, with the fresh id, succeeds
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'stale-mcp-id',
          dir,
          dir,
          undefined,
          undefined,
          discovering([{ name: 'claude.ai Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' }]),
        ),
    );

    assert.deepEqual(postEntityTypeIdsUsed, ['stale-mcp-id', 'mcp-type-id']);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.equal(cache.mcpServerEntityTypeId, 'mcp-type-id'); // fresh id persisted, not stale, not cleared
    assert.deepEqual(cache.knownMcpServerNames, ['claude.ai Gmail']); // the retry succeeded, so it's genuinely known now
  });
});

test('ingestDiscoveredMcpServers runs discovery fresh every call — no throttle, unlike the old CLI-based poll', async () => {
  await withTempDir(async (dir) => {
    let discoverCalls = 0;
    const discover = () => {
      discoverCalls += 1;
      return [];
    };
    await withFetch(
      (async () => new Response(undefined, { status: 200 })) as any,
      async () => {
        await ingestDiscoveredMcpServers(baseCfg, 'mcp-type-id', dir, dir, undefined, undefined, discover);
        await ingestDiscoveredMcpServers(baseCfg, 'mcp-type-id', dir, dir, undefined, undefined, discover);
      },
    );
    assert.equal(discoverCalls, 2);
  });
});

test('ingestDiscoveredMcpServers only ingests names not already known from an earlier session', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({ knownMcpServerNames: ['claude.ai ElevenLabs'] }),
      'utf8',
    );

    let posted: string[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        posted = JSON.parse(opts.body).map((item: any) => item.entityId);
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          dir,
          dir,
          undefined,
          undefined,
          discovering([
            { name: 'claude.ai ElevenLabs', url: 'https://api.elevenlabs.io/v1/mcp' },
            { name: 'claude.ai Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
          ]),
        ),
    );

    assert.deepEqual(posted, ['claude.ai Gmail']);
  });
});

test('ingestDiscoveredMcpServers leaves a failed ingest out of knownMcpServerNames so the next session retries it', async () => {
  await withTempDir(async (dir) => {
    await withFetch(
      (async () => new Response('server error', { status: 500 })) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          dir,
          dir,
          undefined,
          undefined,
          discovering([{ name: 'flaky-server', url: 'https://flaky.example.com/mcp' }]),
        ),
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.equal(cache.knownMcpServerNames.includes('flaky-server'), false);
  });
});

test('ingestDiscoveredMcpServers marks a stdio entry (no url) as known immediately — nothing to retry, no network call', async () => {
  await withTempDir(async (dir) => {
    let fetchCalled = false;
    await withFetch(
      (async () => {
        fetchCalled = true;
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          dir,
          dir,
          undefined,
          undefined,
          discovering([{ name: 'my-local-server', url: undefined }]),
        ),
    );

    assert.equal(fetchCalled, false);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.deepEqual(cache.knownMcpServerNames, ['my-local-server']);
  });
});

// This is the real gap confirmed live: a stdio/connector entry used to be
// marked known unconditionally, even when the registeredMcpServers PATCH
// was actually attempted (userEntityTypeId/userEmail given) and failed for
// an unrelated reason (not the stale-entity-type-id signature — that has
// its own retry path). A single failed bulk call was silently and
// permanently hiding real servers from the real User entity. Contrast with
// the test above: no userEntityTypeId/userEmail at all is a deliberate
// "nothing to attempt" and stays known-immediately; this is a genuine,
// confirmed failure and must NOT be marked known.
test('ingestDiscoveredMcpServers does NOT mark a stdio/connector entry known when the registeredMcpServers PATCH was attempted and failed', async () => {
  await withTempDir(async (dir) => {
    await withFetch(
      (async () => new Response('server error', { status: 500 })) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          dir,
          dir,
          'user-type-id',
          'alice@example.com',
          discovering([{ name: 'claude.ai ElevenLabs', url: undefined }]),
        ),
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.deepEqual(cache.knownMcpServerNames, []); // not known — the next pass will retry it
  });
});

test('ingestDiscoveredMcpServers PATCHes registeredMcpServers per name on the SINGLE endpoint, alongside a bulk MCPServer entity POST', async () => {
  await withTempDir(async (dir) => {
    const calls: { method: string; url: string; body?: any }[] = [];
    await withFetch(
      (async (url: any, opts: any) => {
        calls.push({ method: methodOf(opts), url, body: opts?.body ? JSON.parse(opts.body) : undefined });
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          dir,
          dir,
          'user-type-id',
          'alice@example.com',
          discovering([{ name: 'claude.ai Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' }]),
        ),
    );

    // One PATCH per name, on /entity/{entityId} — NOT /entity/bulk. The bulk
    // endpoint is live-confirmed not to honour op:"ADD" as a Set append:
    // eight ADD ops in one request left the attribute holding one value.
    const patches = calls.filter((c) => c.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.ok(patches[0].url.includes('/entity/alice%40example.com?entityTypeId=user-type-id'));
    assert.ok(!patches[0].url.includes('/entity/bulk'), 'must not use the bulk PATCH endpoint for a Set attribute');
    assert.deepEqual(patches[0].body, {
      op: 'ADD',
      path: 'ATTRIBUTE',
      attributeValue: { name: 'registeredMcpServers', value: 'claude.ai Gmail' },
    });
    const posts = calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.ok(posts[0].url.includes('/entity/bulk?entityTypeId=mcp-type-id'));
    assert.equal(posts[0].body.length, 1);
    assert.equal(posts[0].body[0].entityId, 'claude.ai Gmail');
  });
});

test('ingestDiscoveredMcpServers PATCHes registeredMcpServers for a stdio server too, even though it gets no MCPServer entity', async () => {
  await withTempDir(async (dir) => {
    const calls: { method: string; body?: any }[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        calls.push({ method: methodOf(opts), body: opts?.body ? JSON.parse(opts.body) : undefined });
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          dir,
          dir,
          'user-type-id',
          'alice@example.com',
          discovering([{ name: 'my-local-server', url: undefined }]),
        ),
    );

    // Exactly one call total: the registeredMcpServers PATCH — no POST,
    // since a stdio server has no baseUrl to give it its own entity.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PATCH');
    assert.deepEqual(calls[0].body, {
      op: 'ADD',
      path: 'ATTRIBUTE',
      attributeValue: { name: 'registeredMcpServers', value: 'my-local-server' },
    });
  });
});

test('ingestDiscoveredMcpServers never PATCHes registeredMcpServers for a server already known from an earlier session', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({ knownMcpServerNames: ['claude.ai Gmail'] }),
      'utf8',
    );

    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          dir,
          dir,
          'user-type-id',
          'alice@example.com',
          discovering([{ name: 'claude.ai Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' }]),
        ),
    );

    assert.equal(calls, 0);
  });
});

test('ingestDiscoveredMcpServers without userEntityTypeId/userEmail never attempts registeredMcpServers at all — existing callers are unaffected', async () => {
  await withTempDir(async (dir) => {
    const patchCalls: any[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        if (methodOf(opts) === 'PATCH') patchCalls.push(opts);
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          dir,
          dir,
          undefined,
          undefined,
          discovering([{ name: 'claude.ai Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' }]),
        ),
    );

    assert.equal(patchCalls.length, 0);
  });
});

test('ingestDiscoveredMcpServers still ingests the MCPServer entity even if the registeredMcpServers PATCH fails', async () => {
  await withTempDir(async (dir) => {
    const posts: any[] = [];
    await withFetch(
      (async (_url: any, opts: any) => {
        if (methodOf(opts) === 'PATCH') return new Response('server error', { status: 500 });
        posts.push(...JSON.parse(opts.body));
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          dir,
          dir,
          'user-type-id',
          'alice@example.com',
          discovering([{ name: 'claude.ai Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' }]),
        ),
    );

    // The entity POST is independent of the PATCH and still lands.
    assert.equal(posts.length, 1);
    assert.equal(posts[0].entityId, 'claude.ai Gmail');

    // But the name is NOT marked known, because its registeredMcpServers
    // PATCH failed. This is stricter than it used to be, and deliberately
    // so: marking it known on the POST alone left the User attribute
    // permanently missing that name with nothing ever retrying it — the
    // exact failure that emptied registeredMcpServers on a real tenant
    // while the local cache insisted all fourteen names were done.
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.deepEqual(cache.knownMcpServerNames, [], 'a failed PATCH must leave the name retryable');
  });
});

test('one name failing its PATCH does not hold back the others in the same pass', async () => {
  await withTempDir(async (dir) => {
    // Per-name calls mean per-name outcomes: with the bulk PATCH a single
    // failure took the whole batch down with it.
    await withFetch(
      (async (url: any, opts: any) => {
        if (methodOf(opts) === 'PATCH' && String(opts.body).includes('bad-server')) {
          return new Response('server error', { status: 500 });
        }
        return new Response(undefined, { status: 200 });
      }) as any,
      () =>
        ingestDiscoveredMcpServers(
          baseCfg,
          'mcp-type-id',
          dir,
          dir,
          'user-type-id',
          'alice@example.com',
          discovering([
            { name: 'good-server', url: undefined },
            { name: 'bad-server', url: undefined },
            { name: 'other-server', url: undefined },
          ]),
        ),
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.deepEqual(cache.knownMcpServerNames.sort(), ['good-server', 'other-server']);
    assert.ok(!cache.knownMcpServerNames.includes('bad-server'), 'the failed one retries next pass');
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

test('isMcpDiscoveryDue is true with no pluginDataDir, and true when nothing has ever been recorded', async () => {
  await withTempDir(async (dir) => {
    assert.equal(isMcpDiscoveryDue(undefined), true);
    assert.equal(isMcpDiscoveryDue(dir), true);
  });
});

test('recordMcpDiscoveryTriggered makes isMcpDiscoveryDue false immediately afterward', async () => {
  await withTempDir(async (dir) => {
    recordMcpDiscoveryTriggered(dir);
    assert.equal(isMcpDiscoveryDue(dir), false);
  });
});

test('isMcpDiscoveryDue is true again once the recheck interval has elapsed', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    // Hand-write an already-elapsed trigger time, matching this cache
    // file's own convention, rather than sleeping out a real 15-minute
    // window in a test.
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({ lastMcpDiscoveryTriggeredAt: Date.now() - 16 * 60 * 1000 }),
      'utf8',
    );
    assert.equal(isMcpDiscoveryDue(dir), true);
  });
});

test('recordMcpDiscoveryTriggered merges onto the cache rather than clobbering other fields', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({ knownMcpServerNames: ['claude.ai Gmail'] }),
      'utf8',
    );
    recordMcpDiscoveryTriggered(dir);
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.deepEqual(cache.knownMcpServerNames, ['claude.ai Gmail']);
    assert.ok(typeof cache.lastMcpDiscoveryTriggeredAt === 'number');
  });
});

test('a changed entity-type id clears knownMcpServerNames — a migration must not leave servers stuck "already ingested"', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    // The exact shape observed live after a real migration: ids already
    // refreshed to the new store, server names still there from the old one.
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({
        userEntityTypeId: 'OLD-user',
        agentEntityTypeId: 'OLD-agent',
        mcpServerEntityTypeId: 'OLD-mcp',
        knownMcpServerNames: ['gmail', 'google-calendar', 'miro'],
        lastMcpDiscoveryTriggeredAt: 1234,
        lastMcpInvokeIngestAt: 5678,
      }),
      'utf8',
    );

    await withFetch(
      (async () =>
        new Response(
          JSON.stringify([
            { id: 'NEW-user', name: 'User' },
            { id: 'NEW-agent', name: 'Agent' },
            { id: 'NEW-mcp', name: 'MCPServer' },
          ]),
          { status: 200 },
        )) as any,
      () => resolveEntityTypeIds(baseCfg, dir, true),
    );

    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.equal(cache.userEntityTypeId, 'NEW-user');
    // Everything derived from the dead store is gone, so the next pass
    // re-ingests all three instead of subtracting them as "already done".
    assert.equal(cache.knownMcpServerNames, undefined);
    assert.equal(cache.lastMcpDiscoveryTriggeredAt, undefined);
    assert.equal(cache.lastMcpInvokeIngestAt, undefined);
  });
});

test('an UNCHANGED entity-type id leaves knownMcpServerNames intact — no needless re-ingestion', async () => {
  await withTempDir(async (dir) => {
    fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'entity-types', 'catalog.json'),
      JSON.stringify({
        userEntityTypeId: 'user-type-id',
        agentEntityTypeId: 'agent-type-id',
        mcpServerEntityTypeId: 'mcp-type-id',
        knownMcpServerNames: ['gmail'],
      }),
      'utf8',
    );

    await withFetch(
      (async () => new Response(JSON.stringify(entityTypesResponse), { status: 200 })) as any,
      () => resolveEntityTypeIds(baseCfg, dir, true),
    );

    const cache = JSON.parse(path.join(dir, 'entity-types', 'catalog.json') && fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.deepEqual(cache.knownMcpServerNames, ['gmail'], 'a force-refresh that changes nothing must not wipe the cache');
  });
});

test('a first-ever resolve is not mistaken for a migration', async () => {
  await withTempDir(async (dir) => {
    // Nothing cached at all — there is no "old" id to have changed from.
    await withFetch(
      (async () => new Response(JSON.stringify(entityTypesResponse), { status: 200 })) as any,
      () => resolveEntityTypeIds(baseCfg, dir, true),
    );
    const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
    assert.equal(cache.userEntityTypeId, 'user-type-id');
    assert.equal(cache.knownMcpServerNames, undefined);
  });
});
