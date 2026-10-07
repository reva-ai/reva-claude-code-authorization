# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] — 2026-10-07

### Changed

- **An MCP tool call is now evaluated only when the plugin knows a URL for its server.**
  A server with no URL — stdio, app-provided (`claude-desktop`, `claude-browser`, the iOS
  simulator), an enabled built-in capability, or one not yet discovered — is neither
  ingested nor evaluated, and its tool calls pass straight through to Claude Code's own
  permission system. This narrows what the plugin governs: those calls previously reached
  the RTG, where an unresolvable entity denied them. **No policy applies to them now.**
  Documented in the README, `SECURITY.md`'s decision table and `docs/TROUBLESHOOTING.md`,
  including how to spot it (`REVA_DEBUG=1`, `skipping — MCP server "…" has no known URL`).
- A server with no URL is no longer added to `registeredMcpServers` either, where a stdio
  server's name previously was — so slightly less leaves the machine.
- The identity cache is now also slug-keyed, not only uuid-keyed, so a remote server
  configured by name in `.mcp.json` or `~/.claude.json` can resolve its URL at invoke time
  rather than only a claude.ai connector by uuid.
- **Prompt handling.** The cap on the transmitted prompt rises from 2000 to 10000
  characters, and the desktop app's own `<system-reminder>` blocks are stripped before the
  prompt is cached or transmitted — they are instructions to the model, not the developer's
  words, and arriving first they consumed the length budget ahead of the real prompt.
  Pasted text is kept; only the `<pasted_content>` wrapper tags are removed.

### Fixed

- Re-applied against this development drop, which still branches from before `1.0.0`: the
  `host` install-dialog option and its tests, `package.json`'s release metadata and
  `package` script, `scripts/check-no-real-identifiers.mjs`, and the `surfaceIsolation`
  assertion that fails unless `debug.log` is the only thing Cowork writes.

## [1.3.0] — 2026-10-01

### Changed

- **`PostToolUse` now carries the tool result in its own `transmission.response` field.**
  It previously went in `transmission.userQuery`, which meant the field RTG derives its
  managed prompt from held a tool result on one hook and a prompt on every other.
  `userQuery` is now the same current-hop content `PreToolUse` sends — the command,
  pattern, serialized tool input, or tool name — on both hooks, so one hop's request and
  result line up. `contentType` is consequently always `text/plain` on `PostToolUse`,
  where a JSON result previously forced `application/json`.
- `SECURITY.md` records that `PostToolUse` now repeats the current-hop content alongside
  the tool result. No new category of content leaves the machine — the command and tool
  input were already transmitted at `PreToolUse` — but that hook sends more than it did.

### Fixed

- Re-applied against this development drop, which still branches from before `1.0.0`: the
  `host` install-dialog option and its tests, `package.json`'s release metadata and
  `package` script, `scripts/check-no-real-identifiers.mjs`, and the `surfaceIsolation`
  assertion that fails unless `debug.log` is the only thing Cowork writes.

## [1.2.1] — 2026-09-28

### Fixed

- A session written off by a 401 is no longer counted as an active session. The latch in
  `rtgCircuitBreaker.ts` already meant every later call in that session skipped the RTG, so
  counting it among the concurrent sessions overstated how much of the machine was actually
  governed. The latch file is now the source of truth: a latched session is dropped on every
  read of the registry and never re-registered, so a concurrent hook that loaded the file
  before the 401 cannot resurrect it.
- Removed a comment in `rtgClient.ts` that still described the 4-hour breaker window
  replaced in 1.2.0.
- Re-applied against this development drop, which still branches from before `1.0.0`: the
  `host` install-dialog option and its tests, `package.json`'s release metadata and
  `package` script, `scripts/check-no-real-identifiers.mjs`, and the `surfaceIsolation`
  assertion that fails unless `debug.log` is the only thing Cowork writes.

## [1.2.0] — 2026-09-24

### Added

- `X-Reva-Thread-Id` on every RTG call: the chat's own Claude Code session id, constant
  from a conversation's first prompt to its last. Sent to RTG only, never to ingestion.
- `REVA_DEBUG=1` now reports, on a configuration failure, which source was consulted for
  the auth token and agent id and whether each was absent or present-but-empty — never
  the value. Without it, "missing: REVA_AUTH_TOKEN" misdirects on a normal install, where
  the token arrives from the OS keychain as `CLAUDE_PLUGIN_OPTION_AUTH_TOKEN`.

### Changed

- **Tracing now has three levels instead of two.** The trace id is minted per user prompt
  rather than hashed from the session id, and the span id is derived per operation so the
  `PreToolUse` and `PostToolUse` halves of one tool call share a span. Previously both
  levels sat one step too high and there was no thread identifier at all.
- **The 401 circuit breaker is now a per-session latch, not a 4-hour machine-wide window.**
  The old breaker was keyed by Agent id, so one session's 401 silenced every other session
  on the machine, and nothing closed it on success — a licence repaired five minutes in
  still left almost four hours of ungoverned operation. The latch is keyed by session, has
  no expiry, and starting a new session is the recovery: it always makes a real call.

### Fixed

- `README.md`, `SECURITY.md`, `docs/CONFIGURATION.md` and `docs/TROUBLESHOOTING.md` still
  described the 4-hour breaker window. Corrected to the session latch.
- `SECURITY.md`'s transmitted-metadata table did not mention the correlation identifiers.
- Re-applied against this development drop, which branched before `1.0.0`: the `host`
  install-dialog option and its tests, `package.json`'s release metadata and `package`
  script, `scripts/check-no-real-identifiers.mjs`, and the `surfaceIsolation` assertion
  that fails unless `debug.log` is the only thing Cowork writes.

## [1.1.0] — 2026-09-22

Merges the internal 2.x development line into the public repository. See **Version
numbering** at the end of this entry.

### Added

- Chat/Cowork scope isolation (`src/runtimeScope.ts`): every hook returns without a
  decision, request, or state change on Desktop's local-agent and remote Cowork runtimes.
- MCP server discovery and ingestion, from local files rather than `claude mcp list`.
- A shared MCP server identity so discovery and enforcement name the same server.
- An RTG circuit breaker: a 401 opens a 4-hour window in which RTG is not called.
- A `SessionEnd` hook that removes the session from the active-session registry.
- `REVA_DEBUG=1` now also appends to `debug.log` in the plugin's data directory.
- `scripts/mock-rtg-server.mjs`, replacing the mock PDP server.

### Changed

- **Operational failures now fail closed.** A 404, 424, 5xx, timeout or unreachable host
  blocks the action instead of passing through. Only 401 and 413 still fail open.
- `pdpClient.ts` is now `rtgClient.ts`; the plugin is `reva-security`, display name
  "Reva Security". The `/pdp/v2/ai/evaluation` route and `REVA_PDP_TIMEOUT_MS` keep their
  names — they are the backend's and a public config variable respectively.
- `SessionStart` hook timeout raised from 10s to 30s.

### Fixed

- `SECURITY.md`, `docs/CONFIGURATION.md` and `docs/TROUBLESHOOTING.md` still described the
  old fail-open behaviour. Corrected, per the rule in `CONTRIBUTING.md`.
- Three environment variables the plugin reads were undocumented.
- `package.json` and `.claude-plugin/plugin.json` reported different versions.
- The `host` install-dialog option, `package.json`'s release metadata and
  `scripts/check-no-real-identifiers.mjs` were absent from the development line, which
  predated the `1.0.0` release commit. All three are restored.

### Version numbering

The work in this release was developed on an internal line that numbered itself up to
`2.28.0`. That numbering is not continued here. This repository is the public series and
stays on it: `1.0.0` was the first public release, and this is `1.1.0` — a minor release,
because it adds capability and changes failure behaviour without removing a documented
configuration surface.

## [1.0.0] — 2026-09-11

First public release.

### Added

- `LICENSE` (Apache-2.0) and `NOTICE`.
- `SECURITY.md`, including **What it sends, and what it keeps** — a field-by-field
  statement of everything that leaves a developer's machine, and the full table of which
  conditions block an action and which pass through.
- `CONTRIBUTING.md` and this changelog.
- `docs/INSTALL.md`, `docs/CONFIGURATION.md` and `docs/TROUBLESHOOTING.md`.
- CI (`.github/workflows/ci.yml`): tests on Node 18, 20, 22 and 24; a zero-runtime-
  dependency assertion; `npm audit`; a `dist/`-freshness job; a no-real-identifiers check;
  and a gitleaks scan of the working tree and every commit.
- `scripts/check-no-real-identifiers.mjs`.
- `package.json` now declares `license`, `author`, `repository`, `homepage`, `bugs`,
  `keywords` and `files`.
- `host` is now a declared `userConfig` option, so a tenant on a host other than the
  default `api.reva.ai` can be configured entirely from the install dialog. `REVA_HOST`
  in the environment still takes priority.

### Changed

- Version reconciled to `1.0.0`. `.claude-plugin/plugin.json` previously reported
  `2.17.2` while `package.json` reported `1.0.0`; the two now agree.
- Installation moved from a private GitLab SSH remote to the public GitHub repository, so
  the plugin can be installed by anyone. Both the individual and `managed-settings.json`
  team-rollout instructions were updated.
- The README is now a front door; installation, configuration and troubleshooting detail
  moved into `docs/`.

### Fixed

- The README described the plugin's behaviour when Reva is unreachable but did not
  document that a **missing or unresolvable `REVA_AGENT_ID` blocks every action**. That
  affects anyone authenticating with `ANTHROPIC_API_KEY` rather than an OAuth login. Now
  documented in `docs/CONFIGURATION.md` and `SECURITY.md`.
- The README documented 2 of the 7 environment variables the plugin reads. All 7 are now
  documented.
- The README stated that resources are identified by a repository-relative path "not an
  absolute machine path". The plugin falls back to the absolute path when no git
  repository root can be found, or when the path lies outside it. Corrected.
- A test asserted against an internal Reva development hostname; replaced with
  `api.example.reva.ai`.
- `src/config.ts` referred to a README "Testing" section that did not exist; it now points
  at `CONTRIBUTING.md`.

[1.4.0]: https://github.com/reva-ai/reva-claude-code-authorization/releases/tag/v1.4.0
[1.3.0]: https://github.com/reva-ai/reva-claude-code-authorization/releases/tag/v1.3.0
[1.2.1]: https://github.com/reva-ai/reva-claude-code-authorization/releases/tag/v1.2.1
[1.2.0]: https://github.com/reva-ai/reva-claude-code-authorization/releases/tag/v1.2.0
[1.1.0]: https://github.com/reva-ai/reva-claude-code-authorization/releases/tag/v1.1.0
[1.0.0]: https://github.com/reva-ai/reva-claude-code-authorization/releases/tag/v1.0.0
