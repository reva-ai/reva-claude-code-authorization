"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_HOST = void 0;
exports.urlFromHost = urlFromHost;
exports.loadConfig = loadConfig;
const debug_1 = require("./debug");
const deviceId_1 = require("./deviceId");
const DEFAULT_TIMEOUT_MS = 25000;
// The path segment itself is Reva's actual API route — fixed by the
// backend, not ours to rename regardless of what we call this internally.
const RTG_PATH = '/pdp/v2/ai/evaluation';
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
// escape hatch for local development and the mock-RTG testing workflow
// (README "Testing"), and so anyone already using the older manual
// settings.json `env` approach isn't forced to redo anything.
// Whether a config value arrived, WITHOUT ever revealing it. "set" vs
// "empty" vs "absent" are three different problems: absent means nobody
// configured it, empty means something tried to supply it and handed over
// nothing (a keychain read that failed, a settings layer that was overridden),
// and those need opposite fixes.
function describePresence(value) {
    if (value === undefined)
        return 'absent';
    if (value.length === 0)
        return 'present but EMPTY';
    return `set (${value.length} chars)`;
}
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
    // dialog without anyone editing an environment variable — which is what
    // the README and docs/INSTALL.md tell users to do (`--config host=`).
    // Paths are fixed in code.
    const host = readOption(env, 'REVA_HOST', 'HOST').trim() || exports.DEFAULT_HOST;
    const rtgUrl = urlFromHost(host, RTG_PATH);
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
        // Say WHICH source was consulted and what each one held, never the value
        // itself. Without this the thrown message names only REVA_AUTH_TOKEN,
        // which misdirects on a normal install: there the token arrives as
        // CLAUDE_PLUGIN_OPTION_AUTH_TOKEN out of the OS keychain, so someone
        // reading "missing: REVA_AUTH_TOKEN" goes and sets an env var — papering
        // over a keychain problem AND moving a sensitive token into plaintext
        // settings. This line is the only record that exists: the throw below
        // reaches main().catch, which denies and exits, so nothing else in the
        // process ever gets a chance to log.
        (0, debug_1.debugLog)(`loadConfig: no auth token — REVA_AUTH_TOKEN ${describePresence(env.REVA_AUTH_TOKEN)}, ` +
            `CLAUDE_PLUGIN_OPTION_AUTH_TOKEN ${describePresence(env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN)}`);
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
        (0, debug_1.debugLog)(`loadConfig: no agent id — REVA_AGENT_ID ${describePresence(env.REVA_AGENT_ID)}, ` +
            'resolveAgentId() returned nothing (no Anthropic account logged in on this machine)');
        throw new Error('Reva governance is not configured — missing: REVA_AGENT_ID (no Anthropic account is logged in on this machine — set REVA_AGENT_ID explicitly, e.g. for ANTHROPIC_API_KEY auth)');
    }
    return {
        rtgUrl,
        authorization,
        agentId,
        // REVA_PDP_TIMEOUT_MS is a public, documented config variable — its
        // NAME stays exactly as-is regardless of internal renaming, so an
        // existing deployment that already sets it doesn't silently stop
        // working.
        timeoutMs: Number(env.REVA_PDP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        ingestionUrl,
        ingestionTimeoutMs: Number(env.REVA_INGESTION_TIMEOUT_MS) || DEFAULT_INGESTION_TIMEOUT_MS,
    };
}
