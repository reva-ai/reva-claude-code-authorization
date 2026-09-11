# Troubleshooting

Start here:

```bash
REVA_DEBUG=1 claude
```

Every hook then logs the action it mapped, the decision it received and the reason, to
stderr. Almost everything below is diagnosable from that output.

## Every action is blocked

The plugin fails closed on **misconfiguration** (as opposed to a Reva outage, which fails
open). Three causes, in order of likelihood:

**`REVA_AUTH_TOKEN` is not set.** With debug on you will see
`Reva governance is not configured — missing: REVA_AUTH_TOKEN`. If you set it with
`--config` at install time, note that re-running `install --config` on an already-installed
plugin does not apply a new value — see [INSTALL.md](INSTALL.md#updating-your-token).

**`REVA_AGENT_ID` cannot be resolved.** You will see
`missing: REVA_AGENT_ID (no Anthropic account is logged in on this machine)`. This affects
everyone using `ANTHROPIC_API_KEY` authentication rather than an OAuth login. Set
`REVA_AGENT_ID` explicitly — see
[CONFIGURATION.md](CONFIGURATION.md#if-you-authenticate-with-anthropic_api_key).

**Your policy genuinely denies it.** The block reason names the policy decision rather than
a configuration problem. Check the decision log in your Reva console.

## Nothing appears to be governed

The plugin fails open, silently, whenever Reva cannot give an answer — that is deliberate,
but it means an outage looks like the plugin is not installed. Run with `REVA_DEBUG=1`: a
fail-open pass-through logs a reason such as
`Reva PDP is unavailable — failing open for this request`.

Check in this order:

1. **Is `node` on your PATH?** Every hook shells out to it. `node -v` in the same shell
   Claude Code launched from.
2. **Is the host right?** `REVA_HOST` defaults to `api.reva.ai`. If your tenant is
   elsewhere, every call fails and every action passes through ungoverned.
3. **Is the token still valid?** A 401 fails open by design. The plugin does not warn on
   expiry — it simply stops governing. This is the failure mode worth monitoring.
4. **Did you start a new session?** Configuration is read at session start.

## `dist/src/...js` not found

The hooks execute compiled JavaScript from `dist/`, which is committed. If it is missing,
you have a partial checkout or a modified install:

```bash
npm ci && npm run build
```

## Claude Code hangs on a tool call

An evaluation call can take up to `REVA_PDP_TIMEOUT_MS` (default 25 s) before the plugin
gives up and fails open. The `PreToolUse` and `PostToolUse` hooks are themselves capped at
45 s by `hooks/hooks.json`.

If calls are routinely slow, lower `REVA_PDP_TIMEOUT_MS` — you are trading a longer stall
for governance on a slow link, and a shorter timeout fails open sooner.

## Session start is slow

Session-start ingestion is best-effort and capped separately at
`REVA_INGESTION_TIMEOUT_MS` (default 5 s). It never blocks a session from starting; a
failure is logged under `REVA_DEBUG=1` and otherwise ignored.

On a brand-new install there can be a brief window before you are fully provisioned in
Reva's directory, during which policies referencing you may not match as expected.

## A file outside a repository is denied unexpectedly

Resource ids are repository-relative — `my-repo/src/index.ts` — so one policy works on every
machine. When the file is **not** inside a git repository, or lies outside the repository
root, the plugin falls back to the **absolute path**. A policy written against a
repo-relative pattern will not match that, so the action may be denied by a catch-all rule.

## MCP servers are not showing up in Reva

Only **HTTP** MCP servers are registered. Stdio servers are skipped deliberately: their
entry in `.mcp.json` has no base URL, and the plugin will not invent one. Their `command`,
`args` and `env` are never read, which is also why credentials in a stdio server's `env`
block never leave your machine.

## Known limitations

- Raw model completions and MCP tool-**listing** calls are not gated — only actual tool
  calls and prompts are, since those are the only points Claude Code exposes a hook for.
- Shell command targeting is a best-effort heuristic, not a full shell parser. Common
  patterns resolve correctly; pipes and unusual constructs fall back to a broader resource
  than the command's actual target.
- Directory registration happens in the background at session start and is best-effort.

## Still stuck

Open an issue at
<https://github.com/reva-ai/reva-claude-code-authorization/issues> with your
`REVA_DEBUG=1` output. **Redact the transmitted content first** — debug output includes
prompt and command text.

For anything security-sensitive, email **info@reva.ai** with "SECURITY" in the subject
rather than opening a public issue.
