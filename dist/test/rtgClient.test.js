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
const rtgClient_1 = require("../src/rtgClient");
async function withTempDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reva-governance-rtg-client-'));
    try {
        await fn(dir);
    }
    finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
const baseCfg = {
    rtgUrl: 'https://rtg.test/rtg/v2/ai/evaluation',
    authorization: 'test-token',
    agentId: 'agent-a',
    timeoutMs: 1000,
    ingestionUrl: 'https://rtg.test/ingestion/v2',
    ingestionTimeoutMs: 1000,
};
const baseRequest = {
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
(0, node_test_1.test)('200 always allows by status, even with decision false or malformed JSON', async () => {
    for (const body of [JSON.stringify({ decision: false }), 'not-json']) {
        await withFetch((async () => new Response(body, { status: 200 })), async () => {
            const result = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
            strict_1.default.equal(result.decision, 'allow');
            strict_1.default.equal(result.status, 200);
        });
    }
});
(0, node_test_1.test)('200 with guardrails.outcome "conditional_allow" asks instead of allowing, using guardrails.reason', async () => {
    await withFetch((async () => new Response(JSON.stringify({
        decision: true,
        threadId: 'test-session',
        guardrails: {
            status: 'complete',
            outcome: 'conditional_allow',
            health: 'ok',
            reason: 'Synchronous enforce guardrails conditionally allowed the request.',
        },
    }), { status: 200 })), async () => {
        const result = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
        strict_1.default.equal(result.decision, 'ask');
        strict_1.default.equal(result.status, 200);
        strict_1.default.equal(result.reason, 'Synchronous enforce guardrails conditionally allowed the request.');
    });
});
(0, node_test_1.test)('200 with guardrails.outcome "conditional_allow" but no reason falls back to a default', async () => {
    await withFetch((async () => new Response(JSON.stringify({ decision: true, guardrails: { outcome: 'conditional_allow' } }), {
        status: 200,
    })), async () => {
        const result = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
        strict_1.default.equal(result.decision, 'ask');
        strict_1.default.ok(result.reason);
    });
});
(0, node_test_1.test)('200 with a guardrails block but a different (or absent) outcome still allows', async () => {
    for (const body of [
        JSON.stringify({ decision: true, guardrails: { outcome: 'allow' } }),
        JSON.stringify({ decision: true, guardrails: {} }),
        JSON.stringify({ decision: true }),
    ]) {
        await withFetch((async () => new Response(body, { status: 200 })), async () => {
            const result = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
            strict_1.default.equal(result.decision, 'allow');
        });
    }
});
(0, node_test_1.test)('403 remains a blocking policy deny, always uses the fixed message regardless of context.reason', async () => {
    let calls = 0;
    await withFetch((async () => {
        calls += 1;
        return new Response(JSON.stringify({ context: { reason: 'policy denied' } }), { status: 403 });
    }), async () => {
        const first = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
        const second = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
        strict_1.default.equal(first.decision, 'deny');
        strict_1.default.equal(first.status, 403);
        strict_1.default.equal(first.reason, "Blocked by your organization's security policy.");
        strict_1.default.equal(second.decision, 'deny');
        strict_1.default.equal(calls, 2);
    });
});
(0, node_test_1.test)('every 401 error type fails open, every call, with no persistence of any kind', async () => {
    for (const errorType of ['USER_DISABLED', 'USER_NOT_FOUND']) {
        let calls = 0;
        await withFetch((async () => {
            calls += 1;
            return new Response(JSON.stringify({ error_type: errorType }), { status: 401 });
        }), async () => {
            const first = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
            const second = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
            strict_1.default.equal(first.decision, 'deny');
            strict_1.default.equal(first.inactive, true);
            strict_1.default.equal(first.status, 401);
            strict_1.default.equal(first.errorType, errorType);
            strict_1.default.equal(second.decision, 'deny');
            strict_1.default.equal(second.inactive, true);
            // Both calls hit the RTG — no disable window, no timer, nothing
            // cached. Every request is evaluated fresh.
            strict_1.default.equal(calls, 2);
        });
    }
});
(0, node_test_1.test)('401 without an error_type uses the stable UNAUTHORIZED fallback', async () => {
    await withFetch((async () => new Response('unauthorized', { status: 401 })), async () => {
        const result = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
        strict_1.default.equal(result.decision, 'deny');
        strict_1.default.equal(result.inactive, true);
        strict_1.default.equal(result.errorType, 'UNAUTHORIZED');
    });
});
(0, node_test_1.test)('every 500-599 response fails closed (deny), every call, with no persistence of any kind', async () => {
    for (const status of [500, 502, 503, 504, 599]) {
        let calls = 0;
        const errorType = `ENGINE_${status}`;
        await withFetch((async () => {
            calls += 1;
            return new Response(JSON.stringify({ error_type: errorType }), { status });
        }), async () => {
            const first = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
            const second = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
            strict_1.default.equal(first.decision, 'deny');
            strict_1.default.equal(first.inactive, undefined);
            strict_1.default.equal(first.status, status);
            strict_1.default.equal(first.errorType, errorType);
            strict_1.default.equal(second.decision, 'deny');
            // No circuit breaker, no persistence of any kind — every call hits
            // the RTG fresh even though it keeps erroring.
            strict_1.default.equal(calls, 2);
        });
    }
});
(0, node_test_1.test)('non-JSON 5xx uses the stable RTG_SERVER_ERROR fallback and still fails closed (deny)', async () => {
    await withFetch((async () => new Response('bad gateway', { status: 502 })), async () => {
        const result = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
        strict_1.default.equal(result.decision, 'deny');
        strict_1.default.equal(result.inactive, undefined);
        strict_1.default.equal(result.status, 502);
        strict_1.default.equal(result.errorType, 'RTG_SERVER_ERROR');
    });
});
(0, node_test_1.test)('404 fails closed (deny), using the stable RTG_NOT_FOUND fallback when unset', async () => {
    let calls = 0;
    await withFetch((async () => {
        calls += 1;
        return new Response('', { status: 404 });
    }), async () => {
        const result = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
        strict_1.default.equal(result.decision, 'deny');
        strict_1.default.equal(result.inactive, undefined);
        strict_1.default.equal(result.status, 404);
        strict_1.default.equal(result.errorType, 'RTG_NOT_FOUND');
        strict_1.default.equal(calls, 1);
    });
});
(0, node_test_1.test)('400 and 429 deny without failing open', async () => {
    for (const status of [400, 429]) {
        let calls = 0;
        await withFetch((async () => {
            calls += 1;
            return new Response(JSON.stringify({ message: 'bad request' }), { status });
        }), async () => {
            const result = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
            strict_1.default.equal(result.decision, 'deny');
            strict_1.default.equal(result.inactive, undefined);
            strict_1.default.equal(calls, 1);
        });
    }
});
(0, node_test_1.test)('413 fails open without denying, every call, with no persistence of any kind', async () => {
    let calls = 0;
    await withFetch((async () => {
        calls += 1;
        return new Response(JSON.stringify({ error_type: 'PAYLOAD_TOO_LARGE' }), { status: 413 });
    }), async () => {
        const first = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
        const second = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
        strict_1.default.equal(first.decision, 'allow');
        strict_1.default.equal(first.inactive, true);
        strict_1.default.equal(first.status, 413);
        strict_1.default.equal(first.errorType, 'PAYLOAD_TOO_LARGE');
        strict_1.default.equal(second.decision, 'allow');
        strict_1.default.equal(calls, 2);
    });
});
(0, node_test_1.test)('413 without an error_type uses the stable RTG_PAYLOAD_TOO_LARGE fallback', async () => {
    await withFetch((async () => new Response('too large', { status: 413 })), async () => {
        const result = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
        strict_1.default.equal(result.decision, 'allow');
        strict_1.default.equal(result.inactive, true);
        strict_1.default.equal(result.errorType, 'RTG_PAYLOAD_TOO_LARGE');
    });
});
(0, node_test_1.test)('every 424 response fails closed (deny), every call, using the stable RTG_FAILED_DEPENDENCY fallback when unset', async () => {
    let calls = 0;
    await withFetch((async () => {
        calls += 1;
        return new Response('', { status: 424 });
    }), async () => {
        const first = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
        const second = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
        strict_1.default.equal(first.decision, 'deny');
        strict_1.default.equal(first.inactive, undefined);
        strict_1.default.equal(first.status, 424);
        strict_1.default.equal(first.errorType, 'RTG_FAILED_DEPENDENCY');
        strict_1.default.equal(second.decision, 'deny');
        strict_1.default.equal(calls, 2);
    });
});
(0, node_test_1.test)('network failure synthesizes 503 RTG_UNAVAILABLE and fails closed (deny)', async () => {
    await withFetch((async () => {
        throw new Error('ECONNREFUSED');
    }), async () => {
        const result = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
        strict_1.default.equal(result.decision, 'deny');
        strict_1.default.equal(result.inactive, undefined);
        strict_1.default.equal(result.status, 503);
        strict_1.default.equal(result.errorType, 'RTG_UNAVAILABLE');
    });
});
(0, node_test_1.test)('timeout synthesizes 504 RTG_TIMEOUT and fails closed (deny)', async () => {
    await withFetch(((_url, opts) => new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    })), async () => {
        const result = await (0, rtgClient_1.evaluate)({ ...baseCfg, timeoutMs: 10 }, baseRequest, '00-x-y-01');
        strict_1.default.equal(result.decision, 'deny');
        strict_1.default.equal(result.inactive, undefined);
        strict_1.default.equal(result.status, 504);
        strict_1.default.equal(result.errorType, 'RTG_TIMEOUT');
    });
});
(0, node_test_1.test)('request uses canonical body and raw X-API-Token header', async () => {
    let headers;
    let body;
    await withFetch((async (_url, opts) => {
        headers = opts.headers;
        body = JSON.parse(opts.body);
        return new Response(JSON.stringify({ decision: true }), { status: 200 });
    }), async () => {
        await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01');
    });
    strict_1.default.equal(headers?.['X-API-Token'], 'test-token');
    strict_1.default.equal(headers?.['X-API-Origin-App'], 'CLAUDE_CODE');
    strict_1.default.equal(headers?.['X-Reva-Verification-Codes'], 'CODE_USER_SCOPE');
    strict_1.default.equal(headers?.Authorization, undefined);
    strict_1.default.equal(body.transmission.promptKey, 'userQuery');
    strict_1.default.deepEqual(body.context.hops[0].action, { name: 'invokeAgent' });
    strict_1.default.deepEqual(body.session, baseRequest.session);
    strict_1.default.equal('messages' in body.session, false);
    strict_1.default.equal('entities' in body, false);
    strict_1.default.equal('hops' in body, false);
});
(0, node_test_1.test)('401 latches THIS session: the next call in it skips the RTG entirely', async () => {
    await withTempDir(async (dir) => {
        let calls = 0;
        await withFetch((async () => {
            calls += 1;
            return new Response(JSON.stringify({ error_type: 'USER_NOT_FOUND' }), { status: 401 });
        }), async () => {
            const first = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
            strict_1.default.equal(calls, 1);
            strict_1.default.equal(first.inactive, true);
            const second = await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
            // Still one network call — the latch short-circuited this one.
            strict_1.default.equal(calls, 1);
            strict_1.default.equal(second.decision, 'allow');
            strict_1.default.equal(second.inactive, true);
            strict_1.default.equal(second.status, 401);
            strict_1.default.equal(second.errorType, 'USER_NOT_FOUND');
            strict_1.default.match(second.reason, /unavailable for this session/);
        });
    });
});
(0, node_test_1.test)('a NEW session calls the RTG again — restarting is the recovery', async () => {
    await withTempDir(async (dir) => {
        let calls = 0;
        await withFetch((async () => {
            calls += 1;
            return new Response('', { status: 401 });
        }), async () => {
            await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
            strict_1.default.equal(calls, 1);
            // Same call again in the latched session: skipped.
            await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
            strict_1.default.equal(calls, 1);
            // A different session is untouched and reaches the RTG. Under the old
            // agent-keyed 4-hour window this was silenced too, so a user whose
            // licence had since been fixed kept failing open for hours.
            await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-2');
            strict_1.default.equal(calls, 2);
        });
    });
});
(0, node_test_1.test)('with no session id there is no latch, so every call reaches the RTG', async () => {
    await withTempDir(async (dir) => {
        let calls = 0;
        await withFetch((async () => {
            calls += 1;
            return new Response('', { status: 401 });
        }), async () => {
            // Nothing to key a latch by. A 401 still fails open per call, exactly
            // as it did before any latch existed — it just is not remembered.
            await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01', dir);
            await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01', dir);
            strict_1.default.equal(calls, 2);
        });
    });
});
(0, node_test_1.test)('the latch is keyed by SESSION, not by agent — agentId has no effect on it', async () => {
    await withTempDir(async (dir) => {
        let calls = 0;
        await withFetch((async () => {
            calls += 1;
            return new Response('', { status: 401 });
        }), async () => {
            await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-1');
            strict_1.default.equal(calls, 1);
            // A DIFFERENT agent in the SAME session is still latched: the key is
            // the session id, and agentId is not part of it any more. Under the
            // old scheme this was the reverse — keyed by agent, so it spanned
            // every session on the machine.
            const otherAgent = { ...baseCfg, agentId: 'agent-b' };
            await (0, rtgClient_1.evaluate)(otherAgent, baseRequest, '00-x-y-01', dir, 'sess-1');
            strict_1.default.equal(calls, 1);
            // …and the same agent in a different session is not.
            await (0, rtgClient_1.evaluate)(baseCfg, baseRequest, '00-x-y-01', dir, 'sess-2');
            strict_1.default.equal(calls, 2);
        });
    });
});
