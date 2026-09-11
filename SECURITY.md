# Security

## Reporting a vulnerability

Email **info@reva.ai** with "SECURITY" in the subject. Please include what you found, how to
reproduce it, and what an attacker could do with it. Please do not open a public issue for
anything exploitable.

We will acknowledge within 3 business days and keep you updated until it is resolved. If you
would like credit in the release notes, say so and we will include it.

## What this software is, in security terms

This is an **authorization enforcement point that runs on a developer's workstation**. Claude
Code invokes it through four hooks, and on `PreToolUse` its answer decides whether the tool call
runs at all.

It is not a passive audit log. It sees the developer's prompts and the arguments of every tool
call, and it sends them to a Reva Policy Decision Point over HTTPS to be evaluated.

**Read the next section before deploying this to a team.** A tool that transmits prompts and
command text off the workstation is a meaningful change to a developer's environment, and the
people running it are entitled to know exactly what leaves their machine.

## What it sends, and what it keeps

Every hook sends a request to `https://<REVA_HOST>/pdp/v2/ai/evaluation`. The table below is
the complete set of content that leaves the machine.

| Hook | Content transmitted |
|---|---|
| `UserPromptSubmit` | The **full text of the prompt** the developer submitted. |
| `PreToolUse` (Bash) | The **full shell command**, verbatim. |
| `PreToolUse` (Glob/Grep) | The search pattern. |
| `PreToolUse` (all other tools) | `JSON.stringify(tool_input)` — the whole tool input object. For `Write` this includes **the file content being written**; for `Edit`, the **`old_string` and `new_string`**. |
| `PostToolUse` | The **serialized tool response**, truncated to 2000 characters — i.e. file contents that were read, and command output. |
| every evaluation | The current turn's user prompt, again, as one `conversation` message. |

Alongside the content, each request carries identity and resource metadata:

| Field | Value | Source |
|---|---|---|
| principal | The developer's **email address** | `oauthAccount.emailAddress` in `~/.claude.json`; falls back to the **OS username** if absent |
| subject / agent id | The Anthropic **account UUID** | `oauthAccount.accountUuid`, or `REVA_AGENT_ID` when set |
| resource id | The file, directory or repository acted on | See "Paths" below |
| session | Session id, turn number, and a count of concurrent sessions | local |

At **session start** the plugin also registers entities with Reva's ingestion API: the
developer's email, this machine's **hardware id** (`IOPlatformUUID` on macOS,
`/etc/machine-id` on Linux, `MachineGuid` on Windows), and the agent id.

If the working directory contains a `.mcp.json`, **HTTP** MCP servers in it are registered by
name and base URL. Stdio servers are **skipped entirely** — their `command`, `args` and `env`
are never read or transmitted, so credentials held in a stdio server's `env` block do not
leave the machine through this plugin.

### Paths

A resource id is normally **repo-relative** — `my-repo/src/index.ts` — so one policy applies on
every developer's machine.

It falls back to the **raw absolute path** in two cases: when no git repository root can be
found above the file, and when the path lies outside the repository root. Reading `/etc/hosts`
or editing a file in `~/Documents` therefore transmits the absolute path, which on most systems
contains the local username.

### What stays on the machine

Turn caches, spawn counters and the active-session list are written **only** inside the
directory Claude Code provides as `CLAUDE_PLUGIN_DATA`. There is no fallback path: if that
variable is absent, the state is simply not written. Nothing is written to the repository, to
`/tmp`, or to the home directory.

### What Reva does with it

Content is transmitted to the Reva tenant identified by `REVA_HOST` and evaluated there.
Retention, logging and decision-log contents are properties of **that tenant**, not of this
plugin. If your organization has a policy about where prompt text and source code may be sent,
that policy applies to the Reva tenant you point this at — confirm it before a team rollout.

## What blocks, and what does not

`decision` values are the plugin's, not Claude Code's. "Pass through" means the hook emits no
decision at all, so Claude Code proceeds exactly as if the plugin were not installed.

| Condition | Outcome |
|---|---|
| PDP returns 200 | **allow** |
| PDP returns 200 with `guardrails.outcome: conditional_allow` | **ask** — Claude Code prompts the developer |
| PDP returns 403 | **deny** — the action is blocked |
| PDP returns 401 (bad or expired token) | **pass through** — never blocks |
| PDP returns 5xx | **pass through** — fails open |
| Network error or timeout | **pass through** — fails open |
| PDP returns another 4xx | **deny** |
| `REVA_AUTH_TOKEN` missing | **deny — every action**, until configured |
| `REVA_AGENT_ID` unresolvable and no Anthropic account logged in | **deny — every action**, until configured |
| Internal plugin error (bad stdin, mapping bug) | **deny** |

The split is deliberate: a Reva **outage** must not stop a developer working, but a plugin that
is **misconfigured** must not silently permit everything while appearing to govern.

The practical consequence: a developer authenticating with `ANTHROPIC_API_KEY` rather than an
OAuth login has no resolvable account UUID, and is **blocked on every action** until
`REVA_AGENT_ID` is set explicitly. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Controls, and what each one actually buys you

**The auth token is the only credential.** One token authenticates both evaluation and
ingestion. Supplied through the plugin's `userConfig` it is marked `sensitive`, so Claude Code
stores it in the OS keychain rather than in a plaintext `settings.json`. Supplied as
`REVA_AUTH_TOKEN` it is as exposed as any other environment variable — for a team rollout,
keep it in your secrets manager and let that populate the environment.

**Transport.** HTTPS for every host except `localhost`, `127.0.0.1` and `[::1]`, which use
plain HTTP so a local mock PDP works for testing. A non-local host is always HTTPS; that cannot
be turned off.

**No runtime dependencies.** The plugin uses only the Node standard library. TypeScript and
`@types/node` are dev dependencies. There is no runtime supply chain to compromise.

**Hooks cannot escalate.** Every hook is a short-lived `node` process reading JSON on stdin and
writing JSON on stdout. It runs as the developer, with no elevation, and its only network
egress is to `REVA_HOST`.

## Hardening checklist

- [ ] `REVA_AUTH_TOKEN` supplied through the install-time config dialog (OS keychain) or a
      secrets manager — never committed to a shared `settings.json`
- [ ] `REVA_HOST` set explicitly for your tenant; the built-in default is `api.reva.ai`
- [ ] Token rotation has a named owner — the plugin does not detect or warn on expiry, it
      simply passes traffic through (401 fails open)
- [ ] Developers on `ANTHROPIC_API_KEY` auth have `REVA_AGENT_ID` set, or they are blocked
- [ ] `REVA_DEBUG` unset in normal use — it logs decisions and payload detail to stderr
- [ ] Your team has been told what this transmits, per "What it sends, and what it keeps"
- [ ] The Reva tenant's retention policy for prompt and command content has been reviewed
- [ ] A tag is pinned rather than tracking a branch

## Supported versions

Security fixes are issued for the latest minor release. Pin a tag rather than tracking a
branch.
