# Installing

## Requirements

- **Claude Code**, any recent version.
- **Node.js 18 or later**, with `node` on your `PATH`. Every hook runs as a short-lived
  `node` process, so if `node` is not resolvable the plugin cannot run at all.
- A **Reva auth token** for your tenant, and your tenant's **API host** unless you are on
  the default `api.reva.ai`.

No build step is needed. Compiled JavaScript is committed to the repository, and the hooks
run it directly.

## Individual install

```bash
claude plugin marketplace add https://github.com/reva-ai/reva-claude-code-authorization.git
claude plugin install reva-security@reva-plugins --config auth_token=<your token>
```

Start a new `claude` session afterwards — configuration is read at session start, not live.

Supplying the token through `--config` is the preferred route: the field is marked
`sensitive`, so Claude Code stores it in your OS keychain rather than in a plaintext
settings file.

If your tenant is not on `api.reva.ai`, pass it at install time too:

```bash
claude plugin install reva-security@reva-plugins \
  --config auth_token=<your token> \
  --config host=api.example.reva.ai
```

`REVA_HOST` in the environment overrides the dialog value — see
[CONFIGURATION.md](CONFIGURATION.md).

## Team rollout

Deploy to everyone in your workspace without each person running a command.

**1. Store your workspace token in your organization's secrets manager**, exposed to each
workstation as the environment variable `REVA_AUTH_TOKEN`. Keep it there — not in a shared
config file — so it stays under your secrets manager's own access controls. Set `REVA_HOST`
the same way if you are not on the default host.

**2. Push this file to every workstation**, at
`/Library/Application Support/ClaudeCode/managed-settings.json` (macOS),
`/etc/claude-code/managed-settings.json` (Linux), or
`C:\Program Files\ClaudeCode\managed-settings.json` (Windows):

```json
{
  "extraKnownMarketplaces": {
    "reva-plugins": {
      "source": {
        "source": "git",
        "url": "https://github.com/reva-ai/reva-claude-code-authorization.git"
      }
    }
  },
  "enabledPlugins": { "reva-security@reva-plugins": true }
}
```

Members get the plugin on their next launch. Because `REVA_AUTH_TOKEN` is already in their
environment from step 1, nobody has to run an install command or enter a token.

**Before you roll this out to a team, read
[SECURITY.md](../SECURITY.md#what-it-sends-and-what-it-keeps).** The plugin transmits prompt
text, shell commands and file contents to your Reva tenant, and your developers are entitled
to know that.

## Updating your token

- **Set via `--config` at install time**: re-running `install --config` on an
  already-installed plugin does **not** apply the change. Uninstall and reinstall:

  ```bash
  claude plugin uninstall reva-security@reva-plugins
  claude plugin install reva-security@reva-plugins --config auth_token=<new token>
  ```

- **Set as an environment variable**: update it at the source — your shell profile,
  `settings.json`, or your secrets manager. No reinstall needed.

Either way, start a fresh session afterwards.

## Uninstalling

```bash
claude plugin uninstall reva-security@reva-plugins
```

Local state (turn caches, spawn counters, the active-session list) lives in the directory
Claude Code assigns the plugin and is removed with it. Nothing was written to your
repositories, `/tmp`, or your home directory.
