# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/reva-ai/reva-claude-code-authorization/releases/tag/v1.0.0
