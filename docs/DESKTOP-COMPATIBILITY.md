# Desktop compatibility: Code versus Chat/Cowork

This plugin governs Claude **Code**. It deliberately does nothing on Claude Desktop's
Chat/Cowork runtimes. This page states where the line is drawn, how the plugin decides
which side it is on, what a hook does on the excluded side, and how that is verified.

## Which surfaces are governed

| Surface | Governed |
|---|---|
| `claude` CLI | yes |
| Claude Code VS Code extension | yes |
| Desktop **Code** tab, including third-party-provider Code sessions | yes |
| Any other host that loads Claude Code plugins, including ones that do not exist yet | yes |
| Desktop's local-agent Chat/Cowork runtime | **no** |
| Recognized remote Cowork runtimes | **no** |

A Git repository is not required on the governed side. Ordinary Chat does not execute Code
hooks at all, per Anthropic's own documentation, so there is nothing for the plugin to
exclude there.

## How the distinction is made

The decision uses **host runtime markers only** — never tool names, never workspace paths.
Cowork also has Bash, Read, Write and MCP tools, so a tool-name test would draw the line in
the wrong place. See [`src/runtimeScope.ts`](../src/runtimeScope.ts).

Two signals, in this precedence:

1. **`CLAUDE_CODE_ENTRYPOINT`**, when the host sets it. The values `local-agent`,
   `remote_cowork` and `remote_cowork_trigger` are Cowork; every other value — `cli`,
   `claude-vscode`, `claude-desktop`, `claude-desktop-3p`, `sdk-py`, and anything
   unrecognized — is treated as Code and stays governed.
2. **`CLAUDE_CODE_IS_COWORK=1`**, accepted only when the host set no entrypoint at all.

Two consequences follow, and both are tested:

- **An explicit entrypoint wins over an inherited Cowork flag.** A `claude` CLI launched
  from inside a Cowork session carries `CLAUDE_CODE_IS_COWORK=1` in its environment but
  reports its own entrypoint; it remains fully governed.
- **Unknown or missing markers keep enforcement on.** The exclusion is an allowlist of
  known Cowork runtimes, not a default. A future host the plugin has never heard of is
  governed, not exempted.

As recorded in the source, Desktop 2.110.1 launches its local-agent Chat/Cowork runtime
with `CLAUDE_CODE_ENTRYPOINT=local-agent` and `CLAUDE_CODE_IS_COWORK=1`, and its Code
runtime with `claude-desktop` or `claude-desktop-3p`. The underlying investigation is
tracked outside this repository; this page documents the behaviour the code implements and
the tests that hold it in place.

## What a hook does on an excluded surface

Every registered hook — `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse` — plus the detached MCP-discovery entrypoint (`dist/src/ingestMcpServers.js`)
returns immediately. Specifically, on a Cowork runtime the plugin:

- exits 0 with **empty stdout**, so Claude Code keeps its own native permission behaviour
  and sees no decision from this plugin — not an allow, not a deny;
- makes **no request** to the RTG or to ingestion;
- requires **no Reva configuration** — a missing `REVA_AUTH_TOKEN` or `REVA_AGENT_ID` is
  not an error here, because the check runs before configuration is loaded;
- **does not read the hook payload**: the guard runs before stdin is read, so a host that
  never sends a payload cannot hang a hook;
- writes **no session or plugin state** — no registration, no active-session update, no
  background discovery, no turn cache.

The one thing it may write is a diagnostic: with `REVA_DEBUG=1` it prints
`scope: skipping Chat/Cowork runtime; Claude Code authorization is not applicable` to
stderr and appends the same line to `debug.log` in the plugin's data directory. That file
is opt-in and exists precisely because a hook launched by the Desktop app has no terminal
whose stderr anyone can read. It never contains the payload.

## Verification matrix

[`test/surfaceIsolation.test.ts`](../test/surfaceIsolation.test.ts) drives the real hook
entry points as subprocesses against a local stub server, and fails if any of them speaks
to the network or touches disk when it should not. It asserts, in full combination:

| Dimension | Values |
|---|---|
| Cowork surfaces | `local-agent`, `remote_cowork`, `remote_cowork_trigger`, `CLAUDE_CODE_IS_COWORK=1` |
| Code entrypoints | `cli`, `claude-vscode`, `claude-desktop`, `claude-desktop-3p`, `sdk-py`, an unknown `future-ide`, and no entrypoint at all |
| Hooks | all five, resolved from `hooks/hooks.json` rather than a second hard-coded list |
| Payloads | a valid one, a malformed one, and **stdin left open** — which catches a guard placed after `readStdin()` |

On top of that grid it checks that Cowork stays inert inside a Git repository and for the
tools Cowork shares with Code (`Bash`, `mcp__*`); that the detached MCP-ingestion process
refuses Cowork too; that every Code entrypoint — including the unknown one and the missing
one — still enforces a 200 as allow and a 403 as deny; that malformed input and missing
configuration fail **closed** on Code; that an unknown future tool name cannot slip past a
tool allowlist; and that an inherited Cowork marker never disables a real Code session.

A test also asserts that the set of hooks in `hooks/hooks.json` equals the set in the
isolation matrix, so a newly registered hook cannot ship without being covered here.

## Rollout

Version **1.1.0** is the first public release containing the isolation fix. An older
installed or cached copy keeps running its own older code, so confirm the installed
version before concluding that a Cowork session is exempt.

```bash
claude plugin uninstall reva-security@reva-plugins
claude plugin install reva-security@reva-plugins --config auth_token=<your token>
```

Start a fresh session afterwards — configuration and plugin code are read at session start.
