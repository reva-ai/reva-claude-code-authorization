"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const config_1 = require("../src/config");
// REVA_AGENT_ID is pinned here so every test below is independent of
// whether the machine actually running these tests happens to have a real
// ~/.claude.json — resolveAgentId() has no fallback (see deviceId.ts), so
// without this, these tests would only pass on a machine with a logged-in
// Anthropic account. The dedicated "missing agentId" tests further down
// deliberately omit it instead.
const TOKEN_ENV = { REVA_AUTH_TOKEN: 'auth-token', REVA_AGENT_ID: 'agent-a' };
(0, node_test_1.test)('uses the default auth host when REVA_HOST is unset', () => {
    const cfg = (0, config_1.loadConfig)(TOKEN_ENV);
    strict_1.default.equal(cfg.rtgUrl, `https://${config_1.DEFAULT_HOST}/pdp/v2/ai/evaluation`);
    strict_1.default.equal(cfg.ingestionUrl, `https://${config_1.DEFAULT_HOST}/ingestion/v2`);
});
(0, node_test_1.test)('REVA_HOST overrides the default host', () => {
    const cfg = (0, config_1.loadConfig)({
        ...TOKEN_ENV,
        REVA_HOST: 'localhost:8787',
    });
    strict_1.default.equal(cfg.rtgUrl, 'http://localhost:8787/pdp/v2/ai/evaluation');
    strict_1.default.equal(cfg.ingestionUrl, 'http://localhost:8787/ingestion/v2');
});
(0, node_test_1.test)('throws when REVA_AUTH_TOKEN is missing', () => {
    strict_1.default.throws(() => (0, config_1.loadConfig)({}), /REVA_AUTH_TOKEN/);
});
(0, node_test_1.test)('a single auth token authenticates both evaluation and ingestion — no separate ingestion token', () => {
    const cfg = (0, config_1.loadConfig)(TOKEN_ENV);
    strict_1.default.equal(cfg.authorization, 'auth-token');
    strict_1.default.ok(!('ingestionToken' in cfg));
});
(0, node_test_1.test)('reads token from CLAUDE_PLUGIN_OPTION_* when no REVA_AUTH_TOKEN is set', () => {
    const cfg = (0, config_1.loadConfig)({
        REVA_AGENT_ID: 'agent-a',
        CLAUDE_PLUGIN_OPTION_AUTH_TOKEN: 'from-option-auth',
    });
    strict_1.default.equal(cfg.authorization, 'from-option-auth');
    strict_1.default.equal(cfg.rtgUrl, `https://${config_1.DEFAULT_HOST}/pdp/v2/ai/evaluation`);
});
(0, node_test_1.test)('an explicit REVA_* var wins over the CLAUDE_PLUGIN_OPTION_* one when both are set', () => {
    const cfg = (0, config_1.loadConfig)({
        ...TOKEN_ENV,
        CLAUDE_PLUGIN_OPTION_AUTH_TOKEN: 'from-option',
    });
    strict_1.default.equal(cfg.authorization, 'auth-token');
});
(0, node_test_1.test)('REVA_HOST uses https for non-local hosts', () => {
    const cfg = (0, config_1.loadConfig)({
        ...TOKEN_ENV,
        REVA_HOST: 'api.tenant.example.com',
    });
    strict_1.default.equal(cfg.rtgUrl, 'https://api.tenant.example.com/pdp/v2/ai/evaluation');
    strict_1.default.equal(cfg.ingestionUrl, 'https://api.tenant.example.com/ingestion/v2');
});
(0, node_test_1.test)('host comes from the install-dialog option when REVA_HOST is absent', () => {
    const cfg = (0, config_1.loadConfig)({
        ...TOKEN_ENV,
        CLAUDE_PLUGIN_OPTION_HOST: 'api.example.reva.ai',
    });
    strict_1.default.equal(cfg.rtgUrl, 'https://api.example.reva.ai/pdp/v2/ai/evaluation');
});
(0, node_test_1.test)('REVA_HOST takes priority over the install-dialog option', () => {
    const cfg = (0, config_1.loadConfig)({
        ...TOKEN_ENV,
        REVA_HOST: 'api.example.reva.ai',
        CLAUDE_PLUGIN_OPTION_HOST: 'ignored.example.com',
    });
    strict_1.default.equal(cfg.rtgUrl, 'https://api.example.reva.ai/pdp/v2/ai/evaluation');
});
(0, node_test_1.test)('timeouts still have working defaults — not part of the required/error-if-missing set', () => {
    const cfg = (0, config_1.loadConfig)(TOKEN_ENV);
    strict_1.default.equal(cfg.timeoutMs, 25000);
    strict_1.default.equal(cfg.ingestionTimeoutMs, 5000);
});
(0, node_test_1.test)('agentId resolves from REVA_AGENT_ID', () => {
    const cfg = (0, config_1.loadConfig)(TOKEN_ENV);
    strict_1.default.equal(cfg.agentId, 'agent-a');
});
(0, node_test_1.test)('throws when REVA_AGENT_ID is missing and no Anthropic account is logged in', () => {
    const originalPath = process.env.REVA_CLAUDE_JSON_PATH;
    // Points resolveAgentId()'s underlying readOauthAccountId() at a file
    // that can't exist, so this is deterministic regardless of whether the
    // machine actually running this test has a real ~/.claude.json.
    process.env.REVA_CLAUDE_JSON_PATH = '/nonexistent/reva-governance-test/.claude.json';
    try {
        strict_1.default.throws(() => (0, config_1.loadConfig)({ REVA_AUTH_TOKEN: 'auth-token' }), /REVA_AGENT_ID/);
    }
    finally {
        if (originalPath === undefined)
            delete process.env.REVA_CLAUDE_JSON_PATH;
        else
            process.env.REVA_CLAUDE_JSON_PATH = originalPath;
    }
});
