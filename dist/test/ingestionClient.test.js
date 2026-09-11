"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_test_1 = require("node:test");
const ingestionClient_1 = require("../src/ingestionClient");
const baseCfg = {
    pdpUrl: 'https://pdp.test/evaluate',
    authorization: 'eval-token',
    agentId: 'aa-bb-cc-dd-ee-ff',
    timeoutMs: 1000,
    ingestionUrl: 'https://pdp.test/ingestion/v2',
    ingestionTimeoutMs: 1000,
};
async function withFetch(impl, fn) {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
        return await fn();
    }
    finally {
        globalThis.fetch = original;
    }
}
function withTempDir(fn) {
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
(0, node_test_1.test)('resolveEntityTypeIds fetches and picks the right ids by name alone, including User', async () => {
    await withTempDir(async (dir) => {
        let requestedUrl;
        let headers;
        const ids = await withFetch((async (url, opts) => {
            requestedUrl = url;
            headers = opts.headers;
            return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
        }), () => (0, ingestionClient_1.resolveEntityTypeIds)(baseCfg, dir));
        strict_1.default.equal(ids.userEntityTypeId, 'user-type-id');
        strict_1.default.equal(ids.agentEntityTypeId, 'agent-type-id');
        strict_1.default.equal(ids.mcpServerEntityTypeId, 'mcp-type-id');
        strict_1.default.equal(requestedUrl, 'https://pdp.test/ingestion/v2/policy-store/entity-types');
        strict_1.default.equal(headers?.['X-API-Token'], 'eval-token');
    });
});
(0, node_test_1.test)('resolveEntityTypeIds caches after the first successful fetch — no second network call', async () => {
    await withTempDir(async (dir) => {
        let fetchCount = 0;
        const fetchOnce = (async () => {
            fetchCount++;
            return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
        });
        await withFetch(fetchOnce, () => (0, ingestionClient_1.resolveEntityTypeIds)(baseCfg, dir));
        strict_1.default.equal(fetchCount, 1);
        // Second call should hit the cache, not fetch again — a fetch that
        // throws here would prove the cache wasn't used.
        const second = await withFetch((async () => {
            throw new Error('should not be called — cache should have been used');
        }), () => (0, ingestionClient_1.resolveEntityTypeIds)(baseCfg, dir));
        strict_1.default.equal(second.agentEntityTypeId, 'agent-type-id');
    });
});
(0, node_test_1.test)('resolveEntityTypeIds retries on the next call if MCPServer was missing from an earlier fetch', async () => {
    await withTempDir(async (dir) => {
        let fetchCount = 0;
        // First fetch's response is missing MCPServer entirely (e.g. not yet in
        // the catalog) — Agent resolves fine, but the cache must not be treated
        // as "done" just because that one is present.
        const responseWithoutMcpServer = entityTypesResponse.filter((t) => t.name !== 'MCPServer');
        await withFetch((async () => {
            fetchCount++;
            return new Response(JSON.stringify(responseWithoutMcpServer), { status: 200 });
        }), () => (0, ingestionClient_1.resolveEntityTypeIds)(baseCfg, dir));
        strict_1.default.equal(fetchCount, 1);
        // A later session, once MCPServer is actually in the catalog, must
        // re-fetch rather than getting stuck on the first, incomplete result.
        const second = await withFetch((async () => {
            fetchCount++;
            return new Response(JSON.stringify(entityTypesResponse), { status: 200 });
        }), () => (0, ingestionClient_1.resolveEntityTypeIds)(baseCfg, dir));
        strict_1.default.equal(fetchCount, 2);
        strict_1.default.equal(second.mcpServerEntityTypeId, 'mcp-type-id');
        // And now that MCPServer resolved, a third call should finally use the cache.
        const third = await withFetch((async () => {
            throw new Error('should not be called — cache should now be complete');
        }), () => (0, ingestionClient_1.resolveEntityTypeIds)(baseCfg, dir));
        strict_1.default.equal(third.mcpServerEntityTypeId, 'mcp-type-id');
    });
});
(0, node_test_1.test)('resolveEntityTypeIds falls back to cache when a later fetch would fail', async () => {
    await withTempDir(async (dir) => {
        await withFetch((async () => new Response(JSON.stringify(entityTypesResponse), { status: 200 })), () => (0, ingestionClient_1.resolveEntityTypeIds)(baseCfg, dir));
        // Cache is warm — a failing network must not throw; return the cached ids.
        const result = await withFetch((async () => {
            throw new Error('ECONNREFUSED');
        }), () => (0, ingestionClient_1.resolveEntityTypeIds)(baseCfg, dir));
        strict_1.default.equal(result.agentEntityTypeId, 'agent-type-id');
        strict_1.default.equal(result.mcpServerEntityTypeId, 'mcp-type-id');
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
function methodOf(opts) {
    return opts?.method || 'GET';
}
(0, node_test_1.test)('ingestUser: GET 404 (not found) creates the User with active, registeredMachineIds AND agents in one POST — no follow-up PATCH', async () => {
    await withTempDir(async () => {
        const calls = [];
        await withFetch((async (url, opts) => {
            const method = methodOf(opts);
            calls.push({ method, url, body: opts?.body ? JSON.parse(opts.body) : undefined });
            if (method === 'GET')
                return new Response(undefined, { status: 404 });
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.ingestUser)(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'));
        strict_1.default.equal(calls.length, 2); // GET + POST only — no separate PATCH
        strict_1.default.equal(calls[0].method, 'GET');
        strict_1.default.equal(calls[0].url, 'https://pdp.test/ingestion/v2/entity/alice%40example.com?entityTypeId=user-type-id');
        strict_1.default.equal(calls[1].method, 'POST');
        strict_1.default.equal(calls[1].url, 'https://pdp.test/ingestion/v2/entity?entityTypeId=user-type-id');
        strict_1.default.deepEqual(calls[1].body, {
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
(0, node_test_1.test)('ingestUser: GET 400 is also treated as not-found (creates the User), not just 404', async () => {
    await withTempDir(async () => {
        const calls = [];
        await withFetch((async (_url, opts) => {
            const method = methodOf(opts);
            if (method === 'GET')
                return new Response(undefined, { status: 400 });
            calls.push({ method });
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.ingestUser)(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'));
        strict_1.default.deepEqual(calls, [{ method: 'POST' }]); // POST only — no separate PATCH
    });
});
(0, node_test_1.test)('ingestUser: if the create POST itself fails after a confirmed not-found GET, there is no PATCH fallback — self-heals next session', async () => {
    await withTempDir(async () => {
        const calls = [];
        await withFetch((async (_url, opts) => {
            const method = methodOf(opts);
            if (method === 'GET')
                return new Response(undefined, { status: 404 });
            calls.push({ method });
            return new Response('conflict', { status: 409 });
        }), () => (0, ingestionClient_1.ingestUser)(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'));
        // No fallback PATCH after a failed create — the next session's GET will
        // find the User still missing and retry the whole POST again.
        strict_1.default.deepEqual(calls, [{ method: 'POST' }]);
    });
});
(0, node_test_1.test)('ingestUser: GET 200 (already exists) skips creation — PATCHes registeredMachineIds and agents, never touches active', async () => {
    await withTempDir(async () => {
        const calls = [];
        await withFetch((async (url, opts) => {
            const method = methodOf(opts);
            calls.push({ method, url, body: opts?.body ? JSON.parse(opts.body) : undefined });
            if (method === 'GET') {
                return new Response(JSON.stringify({
                    id: 'entity-1',
                    entityType: null,
                    source: 'API',
                    ownerStoreId: 'store-1',
                    entityAttributes: [{ name: 'active', value: 'false' }],
                    createdOn: '2026-01-01T00:00:00Z',
                    updatedOn: '2026-01-01T00:00:00Z',
                    name: 'alice@example.com',
                }), { status: 200 });
            }
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.ingestUser)(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'));
        strict_1.default.equal(calls.length, 3); // GET + PATCH (registeredMachineIds) + PATCH (agents) — no POST
        strict_1.default.equal(calls[0].method, 'GET');
        strict_1.default.equal(calls[1].method, 'PATCH');
        strict_1.default.deepEqual(calls[1].body, {
            attributeValue: { name: 'registeredMachineIds', value: 'machine-123' },
            op: 'ADD',
            path: 'ATTRIBUTE',
        });
        strict_1.default.equal(calls[2].method, 'PATCH');
        strict_1.default.deepEqual(calls[2].body, {
            attributeValue: { name: 'agents', value: 'agent-abc' },
            op: 'ADD',
            path: 'ATTRIBUTE',
        });
        strict_1.default.ok(!calls.some((c) => c.body && JSON.stringify(c.body).includes('active')));
    });
});
(0, node_test_1.test)('ingestUser: an inconclusive existence check (network failure) skips creation but still attempts both PATCHes', async () => {
    await withTempDir(async () => {
        const calls = [];
        await withFetch((async (_url, opts) => {
            const method = methodOf(opts);
            if (method === 'GET')
                throw new Error('ECONNREFUSED');
            calls.push({ method });
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.ingestUser)(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'));
        strict_1.default.equal(calls.some((c) => c.method === 'POST'), false);
        strict_1.default.equal(calls.filter((c) => c.method === 'PATCH').length, 2);
    });
});
(0, node_test_1.test)('ingestUser: a real 500 from the existence check is also treated as inconclusive, not "not found"', async () => {
    await withTempDir(async () => {
        const calls = [];
        await withFetch((async (_url, opts) => {
            const method = methodOf(opts);
            if (method === 'GET')
                return new Response('server error', { status: 500 });
            calls.push({ method });
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.ingestUser)(baseCfg, 'user-type-id', 'alice@example.com', 'machine-123', 'agent-abc'));
        strict_1.default.equal(calls.some((c) => c.method === 'POST'), false);
        strict_1.default.equal(calls.filter((c) => c.method === 'PATCH').length, 2);
    });
});
(0, node_test_1.test)('ingestAgent: GET 404 (not found) creates the Agent with user AND agentType in one POST — no follow-up PATCH', async () => {
    await withTempDir(async () => {
        const calls = [];
        await withFetch((async (url, opts) => {
            const method = methodOf(opts);
            calls.push({ method, url, body: opts?.body ? JSON.parse(opts.body) : undefined });
            if (method === 'GET')
                return new Response(undefined, { status: 404 });
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.ingestAgent)(baseCfg, 'agent-type-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com'));
        strict_1.default.equal(calls.length, 2); // GET + POST only — no separate PATCH
        strict_1.default.equal(calls[0].method, 'GET');
        strict_1.default.equal(calls[0].url, 'https://pdp.test/ingestion/v2/entity/aa-bb-cc-dd-ee-ff?entityTypeId=agent-type-id');
        strict_1.default.equal(calls[1].method, 'POST');
        strict_1.default.equal(calls[1].url, 'https://pdp.test/ingestion/v2/entity?entityTypeId=agent-type-id');
        strict_1.default.deepEqual(calls[1].body, {
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
(0, node_test_1.test)('ingestAgent: GET 200 (already exists) skips creation — only PATCHes agentType', async () => {
    await withTempDir(async () => {
        const calls = [];
        await withFetch((async (_url, opts) => {
            const method = methodOf(opts);
            if (method === 'GET') {
                return new Response(JSON.stringify({
                    id: 'entity-1',
                    entityType: null,
                    source: 'API',
                    ownerStoreId: 'store-1',
                    entityAttributes: [],
                    createdOn: '2026-01-01T00:00:00Z',
                    updatedOn: '2026-01-01T00:00:00Z',
                    name: 'aa-bb-cc-dd-ee-ff',
                }), { status: 200 });
            }
            calls.push({ method });
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.ingestAgent)(baseCfg, 'agent-type-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com'));
        strict_1.default.deepEqual(calls, [{ method: 'PATCH' }]); // no POST
    });
});
(0, node_test_1.test)('ingestAgent never targets the User entity type — only Agent, across the GET/POST/PATCH it makes', async () => {
    await withTempDir(async () => {
        const entityTypeIdsUsed = new Set();
        await withFetch((async (url, opts) => {
            const params = new URLSearchParams(url.split('?')[1]);
            entityTypeIdsUsed.add(params.get('entityTypeId'));
            if (methodOf(opts) === 'GET')
                return new Response(undefined, { status: 404 });
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.ingestAgent)(baseCfg, 'agent-type-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com'));
        strict_1.default.deepEqual([...entityTypeIdsUsed], ['agent-type-id']);
    });
});
(0, node_test_1.test)('ingestAgent: if the create POST itself fails after a confirmed not-found GET, there is no PATCH fallback — self-heals next session', async () => {
    await withTempDir(async () => {
        const calls = [];
        await withFetch((async (_url, opts) => {
            const method = methodOf(opts);
            if (method === 'GET')
                return new Response(undefined, { status: 404 });
            calls.push({ method });
            return new Response('already exists', { status: 409 });
        }), () => (0, ingestionClient_1.ingestAgent)(baseCfg, 'agent-type-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com'));
        // No fallback PATCH after a failed create — the next session's GET will
        // find the Agent (created concurrently, or not) and PATCH from there.
        strict_1.default.deepEqual(calls, [{ method: 'POST' }]);
    });
});
(0, node_test_1.test)('ingestAgent: an inconclusive existence check skips creation but still attempts the agentType PATCH', async () => {
    await withTempDir(async () => {
        const calls = [];
        await withFetch((async (_url, opts) => {
            const method = methodOf(opts);
            if (method === 'GET')
                throw new Error('ECONNREFUSED');
            calls.push({ method });
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.ingestAgent)(baseCfg, 'agent-type-id', 'aa-bb-cc-dd-ee-ff', 'alice@example.com'));
        strict_1.default.equal(calls.some((c) => c.method === 'POST'), false);
        strict_1.default.equal(calls.some((c) => c.method === 'PATCH'), true);
    });
});
(0, node_test_1.test)('ingestMcpServersFromConfig only ingests entries with a real url, skips stdio entries', async () => {
    await withTempDir(async (dir) => {
        fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
            mcpServers: {
                'remote-server': { url: 'https://example.com/mcp' },
                'stdio-server': { command: 'npx', args: ['some-mcp-server'] },
            },
        }), 'utf8');
        const ingested = [];
        await withFetch((async (url, opts) => {
            const params = new URLSearchParams(url.split('?')[1]);
            strict_1.default.equal(params.get('entityTypeId'), 'mcp-type-id');
            const body = JSON.parse(opts.body);
            ingested.push(body.entityId);
            strict_1.default.deepEqual(body.attributes.find((a) => a.name === 'baseUrl'), { name: 'baseUrl', value: 'https://example.com/mcp' });
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.ingestMcpServersFromConfig)(baseCfg, 'mcp-type-id', dir));
        strict_1.default.deepEqual(ingested, ['remote-server']);
    });
});
(0, node_test_1.test)('ingestMcpServersFromConfig does nothing (and does not throw) when .mcp.json is missing', async () => {
    await withTempDir(async (dir) => {
        let called = false;
        await withFetch((async () => {
            called = true;
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.ingestMcpServersFromConfig)(baseCfg, 'mcp-type-id', dir));
        strict_1.default.equal(called, false);
    });
});
(0, node_test_1.test)('ingestMcpServersFromConfig does nothing when .mcp.json is malformed JSON', async () => {
    await withTempDir(async (dir) => {
        fs.writeFileSync(path.join(dir, '.mcp.json'), '{ not valid json', 'utf8');
        let called = false;
        await withFetch((async () => {
            called = true;
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.ingestMcpServersFromConfig)(baseCfg, 'mcp-type-id', dir));
        strict_1.default.equal(called, false);
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
(0, node_test_1.test)('parseMcpListOutput parses every real connector line, skipping the banner and blank lines', () => {
    const entries = (0, ingestionClient_1.parseMcpListOutput)(REAL_MCP_LIST_OUTPUT);
    strict_1.default.deepEqual(entries, [
        { name: 'claude.ai ElevenLabs', url: 'https://api.elevenlabs.io/v1/mcp' },
        { name: 'claude.ai Unsplash', url: 'https://mcp.unsplash.com/mcp' },
        { name: 'claude.ai Google Drive', url: 'https://drivemcp.googleapis.com/mcp/v1' },
        { name: 'claude.ai Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1' },
        { name: 'claude.ai Google Calendar', url: 'https://calendarmcp.googleapis.com/mcp/v1' },
        { name: 'plugin:context7:context7', url: 'https://mcp.context7.com/mcp' },
    ]);
});
(0, node_test_1.test)('parseMcpListOutput treats a non-URL second token as local/stdio — url left undefined, never fabricated', () => {
    // Real stdio-server line shape is unconfirmed (none configured on the
    // machine this was written on) — this only exercises the parser's actual
    // decision rule: no http(s):// prefix means nothing honest to ingest.
    const entries = (0, ingestionClient_1.parseMcpListOutput)('my-local-server: node - ✔ Connected\n');
    strict_1.default.deepEqual(entries, [{ name: 'my-local-server', url: undefined }]);
});
(0, node_test_1.test)('parseMcpListOutput returns nothing for empty or banner-only output', () => {
    strict_1.default.deepEqual((0, ingestionClient_1.parseMcpListOutput)(''), []);
    strict_1.default.deepEqual((0, ingestionClient_1.parseMcpListOutput)('Checking MCP server health…\n'), []);
});
(0, node_test_1.test)('pollMcpServers ingests every new connector on first run, then skips entirely once due-time has not elapsed', async () => {
    await withTempDir(async (dir) => {
        const posted = [];
        await withFetch((async (url, opts) => {
            posted.push({ entityId: JSON.parse(opts.body).entityId, body: JSON.parse(opts.body) });
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.pollMcpServers)(baseCfg, 'mcp-type-id', dir, () => REAL_MCP_LIST_OUTPUT));
        // Only the 6 real connectors, all url-bearing — none skipped.
        strict_1.default.equal(posted.length, 6);
        strict_1.default.deepEqual(posted[0].body, {
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
        await (0, ingestionClient_1.pollMcpServers)(baseCfg, 'mcp-type-id', dir, () => {
            throw new Error('should not be called — poll should not be due yet');
        });
    });
});
(0, node_test_1.test)('pollMcpServers only ingests names not already known, on a later poll once due', async () => {
    await withTempDir(async (dir) => {
        // Prime the cache as if ElevenLabs was already ingested, and force the
        // throttle open by writing a stale lastMcpServersPolledAt directly.
        fs.mkdirSync(path.join(dir, 'entity-types'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'entity-types', 'catalog.json'), JSON.stringify({ lastMcpServersPolledAt: 0, knownMcpServerNames: ['claude.ai ElevenLabs'] }), 'utf8');
        const posted = [];
        await withFetch((async (_url, opts) => {
            posted.push(JSON.parse(opts.body).entityId);
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.pollMcpServers)(baseCfg, 'mcp-type-id', dir, () => REAL_MCP_LIST_OUTPUT));
        strict_1.default.equal(posted.includes('claude.ai ElevenLabs'), false);
        strict_1.default.equal(posted.length, 5);
    });
});
(0, node_test_1.test)('pollMcpServers leaves a failed ingest out of knownMcpServerNames so the next poll retries it', async () => {
    await withTempDir(async (dir) => {
        await withFetch((async () => new Response('server error', { status: 500 })), () => (0, ingestionClient_1.pollMcpServers)(baseCfg, 'mcp-type-id', dir, () => 'flaky-server: https://flaky.example.com/mcp - ✔ Connected\n'));
        const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
        strict_1.default.equal(cache.knownMcpServerNames.includes('flaky-server'), false);
        // lastMcpServersPolledAt still updates — a poll happened, even though
        // every ingest in it failed — so this doesn't retry on every session.
        strict_1.default.ok(typeof cache.lastMcpServersPolledAt === 'number');
    });
});
(0, node_test_1.test)('pollMcpServers marks a local/stdio entry (no URL) as known immediately — nothing to retry', async () => {
    await withTempDir(async (dir) => {
        let fetchCalled = false;
        await withFetch((async () => {
            fetchCalled = true;
            return new Response(undefined, { status: 200 });
        }), () => (0, ingestionClient_1.pollMcpServers)(baseCfg, 'mcp-type-id', dir, () => 'my-local-server: node - ✔ Connected\n'));
        strict_1.default.equal(fetchCalled, false);
        const cache = JSON.parse(fs.readFileSync(path.join(dir, 'entity-types', 'catalog.json'), 'utf8'));
        strict_1.default.deepEqual(cache.knownMcpServerNames, ['my-local-server']);
    });
});
(0, node_test_1.test)('pollMcpServers does not throw when `claude mcp list` itself fails to run', async () => {
    await withTempDir(async (dir) => {
        await (0, ingestionClient_1.pollMcpServers)(baseCfg, 'mcp-type-id', dir, () => {
            throw new Error('ENOENT: claude not found');
        });
        // No cache file at all — the throttle timestamp is only written after a
        // successful listMcpServers() call, so this correctly retries next time.
        strict_1.default.equal(fs.existsSync(path.join(dir, 'entity-types', 'catalog.json')), false);
    });
});
(0, node_test_1.test)('with no pluginDataDir, nothing persists — no fallback to a home-directory dotfile', async () => {
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
    });
    const first = await withFetch(fetchImpl, () => (0, ingestionClient_1.resolveEntityTypeIds)(baseCfg, undefined));
    strict_1.default.equal(first.agentEntityTypeId, 'agent-type-id'); // still resolves for this call...
    const second = await withFetch(fetchImpl, () => (0, ingestionClient_1.resolveEntityTypeIds)(baseCfg, undefined));
    strict_1.default.equal(second.agentEntityTypeId, 'agent-type-id');
    // ...but a genuine second network fetch happened — nothing was cached
    // without a pluginDataDir to cache it in.
    strict_1.default.equal(fetchCount, 2);
    strict_1.default.equal(fs.existsSync(homeRevaGovernance), existedBefore);
});
