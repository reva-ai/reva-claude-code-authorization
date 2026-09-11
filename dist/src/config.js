"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_HOST = void 0;
exports.urlFromHost = urlFromHost;
exports.loadConfig = loadConfig;
const deviceId_1 = require("./deviceId");
const DEFAULT_TIMEOUT_MS = 25000;
const PDP_PATH = '/pdp/v2/ai/evaluation';
const INGESTION_PATH = '/ingestion/v2';
//  REVA_HOST overrides this.
exports.DEFAULT_HOST = 'api.reva.ai';
// Deliberately much shorter than the evaluation timeout — ingestion is
// best-effort with zero user-facing value on failure (see sessionStart.ts),
// so there's no reason to let it stall session startup anywhere near as
// long as an evaluation call, which is actually gating a real action.
const DEFAULT_INGESTION_TIMEOUT_MS = 5000;
// Values declared in .claude-plugin/plugin.json's `userConfig` are handed to
// this hook process as CLAUDE_PLUGIN_OPTION_<KEY> (key uppercased) — set by
// Claude Code itself once the user fills in the enable-time configuration
// dialog, sensitive ones (tokens) coming from the OS keychain rather than a
// plaintext settings.json. This is the primary, documented way a plugin is
// meant to receive user-supplied config ("use this instead of requiring
// users to hand-edit settings.json").
//
// The plain REVA_* env vars still take priority when present — kept as the
// escape hatch for local development and the mock-PDP testing workflow
// (see CONTRIBUTING.md), and so anyone already using the older manual
// settings.json `env` approach isn't forced to redo anything.
function readOption(env, revaVar, optionKey) {
    return env[revaVar] || env[`CLAUDE_PLUGIN_OPTION_${optionKey}`] || '';
}
function normalizeHost(raw) {
    return raw.trim().replace(/\/+$/, '').replace(/^https?:\/\//, '');
}
function schemeForHost(host) {
    const h = host.toLowerCase();
    if (h.startsWith('localhost') || h.startsWith('127.0.0.1') || h.startsWith('[::1]')) {
        return 'http';
    }
    return 'https';
}
function urlFromHost(host, path) {
    const normalized = normalizeHost(host);
    return `${schemeForHost(normalized)}://${normalized}${path}`;
}
function loadConfig(env = process.env) {
    // Host resolution: REVA_HOST, then the install-dialog `host` option, then
    // the built-in default. Same precedence as the token, so a tenant that is
    // not on the default host can be configured entirely from the install
    // dialog without anyone editing an environment variable. Paths are fixed
    // in code.
    const host = readOption(env, 'REVA_HOST', 'HOST').trim() || exports.DEFAULT_HOST;
    const pdpUrl = urlFromHost(host, PDP_PATH);
    const ingestionUrl = urlFromHost(host, INGESTION_PATH);
    // One token authenticates everything this plugin does — evaluation AND
    // ingestion. No separate ingestion credential, no fallback logic: there's
    // only ever one token to set, here.
    const authorization = readOption(env, 'REVA_AUTH_TOKEN', 'AUTH_TOKEN');
    // Auth token is the only required value — an empty token would just
    // produce a guaranteed, confusing 401 several steps later. Fail immediately
    // with a specific reason instead: authorize.ts/authorizePrompt.ts's
    // existing main().catch(...) turns this into a clear fail-closed deny;
    // sessionStart.ts's own try/catch turns it into a clear skip reason
    // without ever blocking the session.
    if (!authorization) {
        throw new Error('Reva governance is not configured — missing: REVA_AUTH_TOKEN');
    }
    // Defaults to the logged-in Anthropic account id (not a fixed
    // "claude-code" string shared by every install, and not this machine's
    // hardware id — see deviceId.ts's resolveAgentId) so the Agent's Cedar
    // identity is tied to the account, stable across every machine that
    // account uses. No fallback: when no OAuth account is logged in at all
    // (e.g. ANTHROPIC_API_KEY-based auth), resolveAgentId() returns
    // undefined rather than substituting a hardware id or a made-up random
    // one — REVA_AGENT_ID must be set explicitly in that case instead, same
    // as REVA_AUTH_TOKEN above.
    const agentId = env.REVA_AGENT_ID || (0, deviceId_1.resolveAgentId)();
    if (!agentId) {
        throw new Error('Reva governance is not configured — missing: REVA_AGENT_ID (no Anthropic account is logged in on this machine — set REVA_AGENT_ID explicitly, e.g. for ANTHROPIC_API_KEY auth)');
    }
    return {
        pdpUrl,
        authorization,
        agentId,
        timeoutMs: Number(env.REVA_PDP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        ingestionUrl,
        ingestionTimeoutMs: Number(env.REVA_INGESTION_TIMEOUT_MS) || DEFAULT_INGESTION_TIMEOUT_MS,
    };
}
