"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluate = evaluate;
const PDP_UNAVAILABLE = 'PDP_UNAVAILABLE';
const PDP_TIMEOUT = 'PDP_TIMEOUT';
const UNAUTHORIZED = 'UNAUTHORIZED';
const PDP_SERVER_ERROR = 'PDP_SERVER_ERROR';
class PdpTimeoutError extends Error {
}
function parseJson(text) {
    if (!text)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function errorTypeOf(json) {
    const value = json != null && typeof json === 'object' && !Array.isArray(json) ? json.error_type : undefined;
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function errorMessageOf(json) {
    if (json == null || typeof json !== 'object' || Array.isArray(json))
        return undefined;
    const contextReason = json.context?.reason;
    if (typeof contextReason === 'string' && contextReason.trim())
        return contextReason;
    for (const key of ['message', 'error', 'reason']) {
        const value = json[key];
        if (typeof value === 'string' && value.trim())
            return value;
    }
    return undefined;
}
// A 200 with body.guardrails.outcome === "conditional_allow" means the PDP
// ran synchronous guardrails and wants a human to confirm before proceeding
// — not a plain allow. Only this one outcome value is handled (confirmed by
// the user); any other/absent guardrails block still means plain allow, per
// the existing "200 is authoritative allow" contract.
function guardrailsOutcomeOf(json) {
    const guardrails = json != null && typeof json === 'object' && !Array.isArray(json) ? json.guardrails : undefined;
    if (guardrails == null || typeof guardrails !== 'object' || Array.isArray(guardrails))
        return {};
    return {
        outcome: typeof guardrails.outcome === 'string' ? guardrails.outcome : undefined,
        reason: typeof guardrails.reason === 'string' ? guardrails.reason : undefined,
    };
}
async function postJson(cfg, url, body, traceparent) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(cfg.authorization ? { 'X-API-Token': cfg.authorization } : {}),
                    ...(traceparent ? { traceparent } : {}),
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        }
        catch (err) {
            if (controller.signal.aborted) {
                throw new PdpTimeoutError(err?.message || 'PDP request timed out');
            }
            throw err;
        }
        const text = await res.text().catch(() => '');
        return { status: res.status, text, json: parseJson(text) };
    }
    finally {
        clearTimeout(timer);
    }
}
async function postToPdp(cfg, request, traceparent) {
    return postJson(cfg, cfg.pdpUrl, request, traceparent);
}
// 401 (auth/identity failure) and 5xx (PDP-side error) fail open — every
// other rejection is a real policy denial. `inactive: true` tells
// writeDecision() (authorize.ts et al.) to emit no hook decision at all
// rather than an explicit "allow", so a PDP outage or an unrecognized
// principal never blocks Claude Code. This used to also persist a
// multi-hour "hold" so repeated calls could skip re-checking — removed:
// that meant a fix on the Reva side (e.g. a principal getting provisioned)
// wouldn't take effect until the hold's TTL expired. Every call now hits
// the PDP fresh; fail-open still applies per call, it just never sticks
// around past the one request that triggered it.
function handleOperationalStatuses(res) {
    if (res.status === 401) {
        const errorType = errorTypeOf(res.json) || UNAUTHORIZED;
        return {
            decision: 'deny',
            inactive: true,
            reason: `Reva authorization unavailable${errorType ? ` (${errorType})` : ''} — failing open for this request`,
            errorType,
            status: 401,
            raw: res.json ?? res.text,
        };
    }
    if (res.status >= 500 && res.status < 600) {
        const errorType = errorTypeOf(res.json) || PDP_SERVER_ERROR;
        return {
            decision: 'allow',
            inactive: true,
            reason: `Reva PDP error (HTTP ${res.status}${errorType ? ` ${errorType}` : ''}) — failing open for this request`,
            errorType,
            status: res.status,
            raw: res.json ?? res.text,
        };
    }
    return undefined;
}
function handleTransportFailure(err) {
    const timedOut = err instanceof PdpTimeoutError;
    const errorType = timedOut ? PDP_TIMEOUT : PDP_UNAVAILABLE;
    const status = timedOut ? 504 : 503;
    return {
        decision: 'allow',
        inactive: true,
        reason: `Reva PDP ${errorType === PDP_TIMEOUT ? 'timed out' : 'is unavailable'} — failing open for this request`,
        errorType,
        status,
        raw: { error_type: errorType },
    };
}
async function evaluate(cfg, request, traceparent) {
    try {
        const res = await postToPdp(cfg, request, traceparent);
        if (res.status === 200) {
            const guardrails = guardrailsOutcomeOf(res.json);
            if (guardrails.outcome === 'conditional_allow') {
                return {
                    decision: 'ask',
                    reason: guardrails.reason || 'Reva governance requires manual review for this request',
                    status: 200,
                    raw: res.json,
                };
            }
            return {
                // The direct-AI HTTP contract carries policy denial as 403. A 200 is
                // therefore authoritative allow regardless of a legacy/malformed
                // decision member in its body.
                decision: 'allow',
                status: 200,
                raw: res.json,
            };
        }
        if (res.status === 403) {
            return {
                decision: 'deny',
                reason: errorMessageOf(res.json) || 'Denied by Reva governance policy (HTTP 403)',
                errorType: errorTypeOf(res.json),
                status: 403,
                raw: res.json ?? res.text,
            };
        }
        const operational = handleOperationalStatuses(res);
        if (operational)
            return operational;
        // Policy/input 4xx responses other than the explicitly fail-open 401 are
        // real denials. They are not outages and therefore never fail open.
        return {
            decision: 'deny',
            reason: errorMessageOf(res.json) || `Reva PDP rejected the request (HTTP ${res.status}: ${res.text.slice(0, 300)})`,
            errorType: errorTypeOf(res.json),
            status: res.status,
            raw: res.json ?? res.text,
        };
    }
    catch (err) {
        return handleTransportFailure(err);
    }
}
