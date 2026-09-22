# Configuration

The plugin reads ten environment variables. Two are required in practice; the rest have
working defaults, and the last three exist for tests and for the plugin's own detached
child process rather than for you to set.

Values supplied through the install-time config dialog arrive as
`CLAUDE_PLUGIN_OPTION_<KEY>`. A plain `REVA_*` environment variable **takes priority** when
both are present, which is what makes local development and the mock-RTG workflow possible
without reinstalling.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `REVA_AUTH_TOKEN` | **yes** | — | Authenticates every request: RTG evaluation and session-start ingestion. Also settable as `auth_token` in the install dialog, which stores it in your OS keychain. |
| `REVA_AGENT_ID` | **conditionally** | your Anthropic account UUID | The agent's Cedar identity. Resolved automatically from `oauthAccount.accountUuid` in `~/.claude.json`. **Required explicitly when no Anthropic OAuth account is logged in** — see below. |
| `REVA_HOST` | no | `api.reva.ai` | Your Reva tenant's API host. Also settable as `host` in the install dialog. |
| `REVA_DEBUG` | no | off | Set to `1` to log each decision and payload detail to stderr, and to append the same lines, timestamped, to `debug.log` in the plugin's data directory — stderr alone is not readable when the Desktop app runs the hook. |
| `REVA_PDP_TIMEOUT_MS` | no | `25000` | Timeout for an evaluation call. On timeout the plugin fails **closed** — the action is blocked. |
| `REVA_INGESTION_TIMEOUT_MS` | no | `5000` | Timeout for session-start ingestion. Deliberately much shorter — ingestion is best-effort and never gates an action. |
| `REVA_CLAUDE_JSON_PATH` | no | `~/.claude.json` | Overrides where the plugin reads your Anthropic account identity from. Intended for tests. |
| `REVA_CLAUDE_SESSIONS_DIR` | no | `~/.claude/projects` | Overrides where MCP server identity is resolved from. Intended for tests. |
| `REVA_SESSION_CWD` | no | the hook's own cwd | Set by the plugin when it spawns its detached MCP-discovery child, which has no inherited working directory. Not intended to be set by hand. |
| `REVA_INVOKED_MCP_SERVER` | no | — | Set by the plugin on that same child to name the MCP server whose invocation triggered the ingestion. Not intended to be set by hand. |

## If you authenticate with `ANTHROPIC_API_KEY`

Read this section if you do **not** log in to Claude Code with an Anthropic account.

The plugin derives the agent's identity from `oauthAccount.accountUuid` in `~/.claude.json`,
which exists only after an OAuth login. With `ANTHROPIC_API_KEY` authentication there is no
such account, and the plugin deliberately does **not** substitute a machine id or a random
value — an invented identity would be meaningless to a policy.

The result is that the plugin **fails closed and blocks every action** with:

```
Reva governance is not configured — missing: REVA_AGENT_ID
(no Anthropic account is logged in on this machine — set REVA_AGENT_ID explicitly,
 e.g. for ANTHROPIC_API_KEY auth)
```

Set `REVA_AGENT_ID` explicitly to a stable identifier for this agent, and make sure the
matching entity exists in your Reva tenant.

## Hosts and transport

`REVA_HOST` accepts a bare host (`api.example.reva.ai`) or one with a scheme, which is
stripped. Trailing slashes are removed. Paths are fixed in code:

- evaluation: `/pdp/v2/ai/evaluation`
- ingestion: `/ingestion/v2`

The scheme is **HTTPS for every host** except `localhost`, `127.0.0.1` and `[::1]`, which
use plain HTTP so a local mock RTG works. This cannot be overridden for a remote host.

## What blocks and what does not

A short version of the table in [SECURITY.md](../SECURITY.md#what-blocks-and-what-does-not):

| Condition | Outcome |
|---|---|
| Policy denies (403) | **blocked** |
| Guardrails return `conditional_allow` | Claude Code **asks** you |
| Reva unreachable, times out, or errors (5xx, 424, 404) | **blocked, every action** — fails closed |
| Token rejected (401) | **passes through for up to 4 hours** — fails open |
| Payload too large (413) | **passes through** — fails open |
| `REVA_AUTH_TOKEN` or `REVA_AGENT_ID` missing | **blocked, every action** — fails closed |

Governance holds through a Reva-side outage: an unreachable or erroring RTG blocks rather
than silently letting actions through. The exceptions are a rejected token (401), which
passes through for up to 4 hours because it usually means a principal that is not
provisioned yet, and an oversized payload (413), which concerns one request only. A
misconfiguration must never silently permit everything while appearing to govern.

## Policies

Policies are authored and managed in Reva, not here — this plugin only enforces what your
organization has configured. Rules can be scoped to any governed action and to specific
resources, from "no shell commands anywhere" to "file writes only inside this repository".
See your Reva console.
