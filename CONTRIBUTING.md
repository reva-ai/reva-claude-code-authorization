# Contributing

## Before you open a pull request

```bash
npm ci
npm test                                   # no network; 433 tests
npm run build                              # dist/ must be committed in sync with src/
node scripts/check-no-real-identifiers.mjs # nothing real may land in a public repo
```

All four run in CI, along with `npm audit`, a check that the package still has **zero**
runtime dependencies, and a [gitleaks](https://github.com/gitleaks/gitleaks) scan of the
working tree *and* every commit.

The two secret checks are not redundant. `check-no-real-identifiers.mjs` knows this
project — our internal hostnames, our own token shapes, our default host — and gitleaks
knows the wider world's credential formats: GitHub PATs, Slack tokens, Azure client
secrets, cloud API keys. Each catches things the other misses.

## Three rules that are not negotiable

**No real identifiers.** This repository is public. Internal hostnames, tokens, account
UUIDs, machine ids and personal email addresses must never appear — including in comments
and test fixtures. Use `api.example.reva.ai` for hosts and `dev@example.com` for
addresses. The check above enforces this.

**No runtime dependencies.** The plugin uses only the Node standard library. This is a
security control, not an aesthetic: these hooks run on a developer's workstation on every
tool call, and a package with no supply chain cannot have one compromised. TypeScript is a
devDependency and never runs in the hook path. If you believe a runtime dependency is
genuinely necessary, open an issue first.

**`dist/` is committed, and must match `src/`.** The hooks execute `dist/src/*.js`
directly — there is no install or build step on a developer's machine. A stale `dist/`
means the plugin silently runs old authorization logic. Run `npm run build` and commit the
result with your change; CI fails the PR otherwise.

## Changing what gets sent to Reva

`SECURITY.md` documents exactly what leaves a developer's machine, field by field. If your
change adds, removes or widens a transmitted field, **update that section in the same
pull request**. A data-handling statement that has drifted from the code is worse than
none, because people rely on it when approving a rollout.

## Tests

`node:test`, no framework. Prefer a test that drives a hook entry point over one that
asserts on an internal helper; the hook contract is what Claude Code depends on.

Authorization controls need a test that shows the control **denying**, not only
permitting — a test that only checks the happy path would still pass if the control were
removed. The fail-open/fail-closed split in `rtgClient.ts` is the security-critical part:
every branch of it has a test, and new branches need one too.

`scripts/mock-rtg-server.mjs` serves a local RTG (and ingestion API) for manual testing:

```bash
npm run mock-rtg                 # in one terminal
REVA_HOST=localhost:8787 REVA_AUTH_TOKEN=test claude   # in another
```

`localhost`, `127.0.0.1` and `[::1]` are the only hosts the plugin will talk to over plain
HTTP; everything else is HTTPS.

## Commit messages

Explain why the change is correct, not what the diff shows. If behaviour changed because
of something observed from a live system, say what was observed.
