import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate } from '../src/pdpClient';
import { CedarRequest, RevaConfig } from '../src/types';

const baseCfg: RevaConfig = {
  pdpUrl: 'https://pdp.test/pdp/v2/ai/evaluation',
  authorization: 'test-token',
  agentId: 'agent-a',
  timeoutMs: 1000,
  ingestionUrl: 'https://pdp.test/ingestion/v2',
  ingestionTimeoutMs: 1000,
};

const baseRequest: CedarRequest = {
  subject: { type: 'Agent', id: 'agent-a' },
  principal: { type: 'User', id: 'alice@example.com' },
  action: { name: 'invokeTool' },
  resource: { type: 'Tool', id: 'WebFetch', properties: { name: 'WebFetch' } },
  context: {
    timestamp: 1,
    prompt: 'find docs',
    hops: [
      {
        seq: 1,
        subject: { type: 'User', id: 'alice@example.com' },
        action: { name: 'invokeAgent' },
        resource: { type: 'Agent', id: 'agent-a' },
        time: '2026-08-19T10:00:00Z',
      },
    ],
  },
  transmission: {
    promptKey: 'userQuery',
    userQuery: 'WebFetch',
    role: 'assistant',
    contentType: 'text/plain',
  },
  session: { id: 'sess-1', turn: 1, startedAt: '2026-08-19T10:00:00Z' },
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

test('200 always allows by status, even with decision false or malformed JSON', async () => {
  for (const body of [JSON.stringify({ decision: false }), 'not-json']) {
    await withFetch(
      (async () => new Response(body, { status: 200 })) as any,
      async () => {
        const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        assert.equal(result.decision, 'allow');
        assert.equal(result.status, 200);
      },
    );
  }
});

test('200 with guardrails.outcome "conditional_allow" asks instead of allowing, using guardrails.reason', async () => {
  await withFetch(
    (async () =>
      new Response(
        JSON.stringify({
          decision: true,
          threadId: 'test-session',
          guardrails: {
            status: 'complete',
            outcome: 'conditional_allow',
            health: 'ok',
            reason: 'Synchronous enforce guardrails conditionally allowed the request.',
          },
        }),
        { status: 200 },
      )) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'ask');
      assert.equal(result.status, 200);
      assert.equal(result.reason, 'Synchronous enforce guardrails conditionally allowed the request.');
    },
  );
});

test('200 with guardrails.outcome "conditional_allow" but no reason falls back to a default', async () => {
  await withFetch(
    (async () =>
      new Response(JSON.stringify({ decision: true, guardrails: { outcome: 'conditional_allow' } }), {
        status: 200,
      })) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'ask');
      assert.ok(result.reason);
    },
  );
});

test('200 with a guardrails block but a different (or absent) outcome still allows', async () => {
  for (const body of [
    JSON.stringify({ decision: true, guardrails: { outcome: 'allow' } }),
    JSON.stringify({ decision: true, guardrails: {} }),
    JSON.stringify({ decision: true }),
  ]) {
    await withFetch(
      (async () => new Response(body, { status: 200 })) as any,
      async () => {
        const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        assert.equal(result.decision, 'allow');
      },
    );
  }
});

test('403 remains a blocking policy deny, reads context.reason', async () => {
  let calls = 0;
  await withFetch(
    (async () => {
      calls += 1;
      return new Response(JSON.stringify({ context: { reason: 'policy denied' } }), { status: 403 });
    }) as any,
    async () => {
      const first = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      const second = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(first.decision, 'deny');
      assert.equal(first.status, 403);
      assert.equal(first.reason, 'policy denied');
      assert.equal(second.decision, 'deny');
      // No circuit — every call hits the PDP fresh, on purpose (see
      // pdpClient.ts's own comment on why the old persisted hold was
      // removed).
      assert.equal(calls, 2);
    },
  );
});

test('every 401 error type fails open for that one call, but never persists', async () => {
  for (const errorType of ['USER_DISABLED', 'USER_NOT_FOUND']) {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error_type: errorType }), { status: 401 });
      }) as any,
      async () => {
        const first = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        const second = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        assert.equal(first.decision, 'deny');
        assert.equal(first.inactive, true);
        assert.equal(first.status, 401);
        assert.equal(first.errorType, errorType);
        assert.equal(second.decision, 'deny');
        assert.equal(second.inactive, true);
        // Both calls hit the PDP — nothing cached, so a fix on the Reva
        // side is reflected on the very next call, not after a TTL.
        assert.equal(calls, 2);
      },
    );
  }
});

test('401 without an error_type uses the stable UNAUTHORIZED fallback', async () => {
  await withFetch(
    (async () => new Response('unauthorized', { status: 401 })) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'deny');
      assert.equal(result.inactive, true);
      assert.equal(result.errorType, 'UNAUTHORIZED');
    },
  );
});

test('every 500-599 response fails open for that one call, preserving status/type', async () => {
  for (const status of [500, 502, 503, 504, 599]) {
    let calls = 0;
    const errorType = `ENGINE_${status}`;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response(JSON.stringify({ error_type: errorType }), { status });
      }) as any,
      async () => {
        const first = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        const second = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        assert.equal(first.decision, 'allow');
        assert.equal(first.inactive, true);
        assert.equal(first.status, status);
        assert.equal(first.errorType, errorType);
        assert.equal(second.inactive, true);
        assert.equal(calls, 2);
      },
    );
  }
});

test('non-JSON 5xx uses the stable PDP_SERVER_ERROR fallback and still fails open', async () => {
  await withFetch(
    (async () => new Response('bad gateway', { status: 502 })) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'allow');
      assert.equal(result.inactive, true);
      assert.equal(result.status, 502);
      assert.equal(result.errorType, 'PDP_SERVER_ERROR');
    },
  );
});

test('400 and 413 deny without failing open', async () => {
  for (const status of [400, 413]) {
    let calls = 0;
    await withFetch(
      (async () => {
        calls += 1;
        return new Response(JSON.stringify({ message: 'bad request' }), { status });
      }) as any,
      async () => {
        const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
        assert.equal(result.decision, 'deny');
        assert.equal(result.inactive, undefined);
        assert.equal(calls, 1);
      },
    );
  }
});

test('network failure synthesizes 503 PDP_UNAVAILABLE and fails open', async () => {
  await withFetch(
    (async () => {
      throw new Error('ECONNREFUSED');
    }) as any,
    async () => {
      const result = await evaluate(baseCfg, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'allow');
      assert.equal(result.inactive, true);
      assert.equal(result.status, 503);
      assert.equal(result.errorType, 'PDP_UNAVAILABLE');
    },
  );
});

test('timeout synthesizes 504 PDP_TIMEOUT and fails open', async () => {
  await withFetch(
    ((_url: any, opts: any) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      })) as any,
    async () => {
      const result = await evaluate({ ...baseCfg, timeoutMs: 10 }, baseRequest, '00-x-y-01');
      assert.equal(result.decision, 'allow');
      assert.equal(result.inactive, true);
      assert.equal(result.status, 504);
      assert.equal(result.errorType, 'PDP_TIMEOUT');
    },
  );
});

test('request uses canonical body and raw X-API-Token header', async () => {
  let headers: Record<string, string> | undefined;
  let body: any;
  await withFetch(
    (async (_url: any, opts: any) => {
      headers = opts.headers;
      body = JSON.parse(opts.body);
      return new Response(JSON.stringify({ decision: true }), { status: 200 });
    }) as any,
    async () => {
      await evaluate(baseCfg, baseRequest, '00-x-y-01');
    },
  );
  assert.equal(headers?.['X-API-Token'], 'test-token');
  assert.equal(headers?.Authorization, undefined);
  assert.equal(body.transmission.promptKey, 'userQuery');
  assert.deepEqual(body.context.hops[0].action, { name: 'invokeAgent' });
  assert.deepEqual(body.session, baseRequest.session);
  assert.equal('messages' in body.session, false);
  assert.equal('entities' in body, false);
  assert.equal('hops' in body, false);
});
