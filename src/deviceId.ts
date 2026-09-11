import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Ties the Agent's Cedar identity to the logged-in Anthropic account
// (oauthAccount.accountUuid — stable across every machine that account logs
// into), not to any one machine. Per-machine tracking still happens, just
// separately: the current machine's hardware id is appended to the User
// entity's registeredMachineIds Set (see ingestionClient.ts), not used as
// Agent's own id anymore. No fallback: when no OAuth account is available at
// all (e.g. ANTHROPIC_API_KEY-based auth, which has no "account" to key on),
// resolveAgentId returns undefined rather than substituting a hardware id or
// a made-up random one — a machine/random id is not the account, and
// silently using one as the Agent's permanent Cedar identity would be
// dishonest. config.ts requires REVA_AGENT_ID to be set explicitly in that
// case, the same way it requires REVA_AUTH_TOKEN — see resolveAgentId below.
//
// This only reports an honest, self-declared value — actual "this token
// can't be used from another account/machine" enforcement has to happen in
// Reva's policies (checking principal.id/context against what's registered
// for that token/user). A malicious client could still misreport this;
// it's identity-fingerprinting, not attestation.

// The account actually logged into Claude Code — fetched from Anthropic's
// backend at OAuth login. Used as the CodingAgent schema's `User` principal.
// Read from ~/.claude.json; REVA_CLAUDE_JSON_PATH overrides the path for tests.
export function readOauthEmail(claudeJsonPath?: string): string | undefined {
  try {
    const filePath =
      claudeJsonPath ||
      (process.env.REVA_CLAUDE_JSON_PATH?.length ? process.env.REVA_CLAUDE_JSON_PATH : undefined) ||
      path.join(os.homedir(), '.claude.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    const email = data?.oauthAccount?.emailAddress;
    if (typeof email === 'string' && email.length > 0) {
      return email;
    }
  } catch {
    // file missing, unreadable, malformed, or no oauthAccount.emailAddress —
    // fall through to the git-config / OS-username fallback chain in identity.ts
  }
  return undefined;
}

// Same source file as readOauthEmail, same OAuth login moment — accountUuid
// is Anthropic's own stable account identifier (confirmed live: a real
// UUID under oauthAccount, distinct from organizationUuid — the org, not
// the person — and from the top-level userID, which looks like a
// local/install-derived hash rather than a portable account id). Now used
// as the Cedar `Agent` entity's id (see resolveAgentId below).
export function readOauthAccountId(claudeJsonPath?: string): string | undefined {
  try {
    const filePath =
      claudeJsonPath ||
      (process.env.REVA_CLAUDE_JSON_PATH?.length ? process.env.REVA_CLAUDE_JSON_PATH : undefined) ||
      path.join(os.homedir(), '.claude.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    const accountId = data?.oauthAccount?.accountUuid;
    if (typeof accountId === 'string' && accountId.length > 0) {
      return accountId;
    }
  } catch {
    // file missing, unreadable, malformed, or no oauthAccount.accountUuid —
    // fall through to the hardware-id / persisted-random-id chain below
  }
  return undefined;
}

function readMacHardwareId(): string | undefined {
  try {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return out.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/)?.[1];
  } catch {
    return undefined;
  }
}

function readLinuxMachineId(): string | undefined {
  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const id = fs.readFileSync(p, 'utf8').trim();
      if (id) return id;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function readWindowsMachineGuid(): string | undefined {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { encoding: 'utf8', timeout: 2000 },
    );
    return out.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/)?.[1];
  } catch {
    return undefined;
  }
}

// Exported directly: the CodingAgent schema's `Agent` entity is
// hardware-rooted by design (mac hardware UUID on macOS, /etc/machine-id on
// Linux, MachineGuid on Windows) — this is the primary source for
// resolveAgentId below, not just an internal fallback.
export function readOsHardwareId(): string | undefined {
  switch (process.platform) {
    case 'darwin':
      return readMacHardwareId();
    case 'linux':
      return readLinuxMachineId();
    case 'win32':
      return readWindowsMachineGuid();
    default:
      return undefined;
  }
}

// Used only when no OS-level hardware id is available (unsupported
// platform, sandboxed environment, permission denied, etc). Persisted in
// Claude Code's plugin data directory (CLAUDE_PLUGIN_DATA — the officially
// documented mechanism for exactly this), which survives plugin updates.
// No fallback to a dotfile in the home directory: without dataDir, there's
// nothing honest to write to, so this just generates a fresh id on every
// call instead — still a usable id for the current run, just not stable
// across future runs.
export function persistedFallbackId(dataDir: string | undefined): string {
  if (!dataDir) return randomUUID();

  const file = path.join(dataDir, 'device-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // doesn't exist yet — generate and persist below
  }
  const id = randomUUID();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, id, 'utf8');
  } catch {
    // best effort — if persistence fails, this run still gets a usable id,
    // just not a stable one across future runs
  }
  return id;
}

let cachedAgentId: string | undefined;
let cachedMachineId: string | undefined;

// This machine's own id: the real hardware id (mac address / machine-id /
// MachineGuid) when available, falling back to a persisted random id only
// when no OS-level hardware id is available at all (unsupported platform,
// sandboxed environment, permission denied). Used directly as the value
// PATCH-ADDed to User.registeredMachineIds (ingestionClient.ts) — that Set
// specifically needs THIS machine's id, never the account id. Unlike
// resolveAgentId below, a fallback makes sense here: there's no "real"
// per-machine identity to defer to, so a persisted random id is an honest
// answer to "some stable way to tell this machine apart," not a stand-in
// for something else.
export function resolveMachineId(pluginDataDir?: string): string {
  if (!cachedMachineId) {
    cachedMachineId = readOsHardwareId() || persistedFallbackId(pluginDataDir);
  }
  return cachedMachineId;
}

// Resolves the id for the Cedar `Agent` entity: the logged-in Anthropic
// account id (accountUuid — stable across every machine that account uses),
// and nothing else. No fallback to resolveMachineId or a random id — when
// not logged in via claude.ai OAuth at all (e.g. ANTHROPIC_API_KEY-based
// auth, which has no "account" to key on), this returns undefined and
// callers must require REVA_AGENT_ID to be set explicitly instead (see
// config.ts) rather than this plugin inventing a substitute identity.
export function resolveAgentId(): string | undefined {
  if (!cachedAgentId) {
    cachedAgentId = readOauthAccountId();
  }
  return cachedAgentId;
}
