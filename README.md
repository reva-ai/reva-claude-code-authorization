<img src="assets/reva.svg" alt="Reva" width="44">

# Reva runtime authorization for Claude Code

A Claude Code plugin that authorizes every tool call and every submitted prompt. Claude Code
calls it before an action runs; it asks a Reva policy decision point whether the action is
allowed, and answers allow, ask or block — **before it runs**, not logged after the fact.

The same enforcement Reva applies at the API gateway, brought down to the coding-agent layer.

Plugin id: `reva-governance`, from the `reva-plugins` marketplace.

- [How it works](#how-it-works)
- [What gets governed](#what-gets-governed)
- [What it sends](#what-it-sends)
- [What blocks, and what doesn't](#what-blocks-and-what-doesnt)
- [Install](#install)
- [Documentation](#documentation)

## How it works

The plugin hooks four points in a Claude Code session:

| When | What happens |
| --- | --- |
| A session starts | Registers you and your machine with Reva's directory, so policies can reference you by the time you do anything. Never blocks a session from starting. |
| You submit a prompt | Checks whether you're allowed to invoke the coding agent at all this turn. |
| Before any tool call | Checks whether that specific action is allowed, and blocks it if not. |
| After a tool call completes | Re-evaluates with the actual result, for policies that care what a command returned. |

Every check is synchronous, before (or immediately after) the action.

## What gets governed

Each Claude Code tool maps to a named action, so a policy can distinguish "read a file"
from "run an arbitrary shell command" rather than lumping everything under one permission:

| Claude Code does this | Governed as |
| --- | --- |
| Runs a shell command | `executeBash` |
| Reads a file | `read` |
| Writes a file | `write` |
| Edits a file | `edit` |
| Searches a directory | `glob` / `grep` |
| Calls an external/MCP tool | `invokeTool` |
| Spawns a sub-agent | `spawn` |
| Starts a new turn | `invokeAgent` |

Resources are identified by a **repository-relative** path — `my-repo/src/index.ts` — so a
policy written once ("only allow this inside `my-repo/src/**`") works on every developer's
machine regardless of where they cloned it. When a file is not inside a git repository, or
lies outside the repository root, the plugin falls back to the absolute path.

## What it sends

This plugin transmits **the text of your prompts, your shell commands, and the contents of
files being written or read** to your Reva tenant for evaluation.

That is the point — a policy cannot judge an action it cannot see — but it is a real change
to your environment, and anyone rolling this out to a team should read the field-by-field
statement first:

**→ [SECURITY.md — What it sends, and what it keeps](SECURITY.md#what-it-sends-and-what-it-keeps)**

Local state never leaves the directory Claude Code assigns the plugin. Nothing is written to
your repositories, `/tmp`, or your home directory.

## What blocks, and what doesn't

| Condition | Outcome |
|---|---|
| Policy denies | **blocked** |
| Guardrails return `conditional_allow` | Claude Code **asks** you |
| Reva unreachable, times out, or errors | **passes through** — fails open |
| Token rejected (401) | **passes through** — fails open |
| `REVA_AUTH_TOKEN` or `REVA_AGENT_ID` missing | **blocked, every action** — fails closed |

A Reva outage degrades to "no extra governance for that moment", never to a stuck coding
assistant. A **misconfiguration** blocks instead, so the plugin can't silently permit
everything while appearing to govern.

If you authenticate with `ANTHROPIC_API_KEY` rather than an OAuth login, `REVA_AGENT_ID`
must be set explicitly or you will be blocked on every action —
[see CONFIGURATION.md](docs/CONFIGURATION.md#if-you-authenticate-with-anthropic_api_key).

## Install

Requires **Node.js 18+** with `node` on your `PATH` — every hook runs as a `node` process.

```bash
claude plugin marketplace add https://github.com/reva-ai/reva-claude-code-authorization.git
claude plugin install reva-governance@reva-plugins --config auth_token=<your token>
```

Start a new `claude` session afterwards. If your tenant is not on `api.reva.ai`, add
`--config host=<your host>`.

Team rollout via `managed-settings.json`, token rotation, and uninstall are in
[docs/INSTALL.md](docs/INSTALL.md).

## Documentation

| | |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Requirements, individual and team install, updating your token |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | All seven environment variables, hosts and transport, policies |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Debug output, why everything is blocked, why nothing is governed, known limitations |
| [SECURITY.md](SECURITY.md) | What leaves your machine, the threat model, hardening checklist, reporting a vulnerability |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Tests, the three non-negotiable rules, local mock PDP |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
