import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DirectEvalConversationMessage, DirectEvalSession } from './types';

// PreToolUse hooks don't receive the user's prompt text directly — only
// UserPromptSubmit does — and each hook invocation is a separate stateless
// process, so there's no in-memory way to share state between them.
//
// Also used to pin the span id for an entire turn: rather than trusting
// Claude Code's own prompt_id to reliably distinguish turns in every mode
// (live testing showed it works via `-p --resume`, but not confirmed
// identical in an interactive session), UserPromptSubmit mints its own
// fresh id here and every PreToolUse call in that turn reads the same
// value back — the plugin owns the turn boundary itself instead of relying
// on an upstream field we don't fully control.
//
// Best-effort throughout: if the cache can't be written or read, actions
// just proceed without turn-scoped context rather than failing.

export interface TurnCacheEntry {
  spanId: string;
  prompt?: string;
  promptTimestamp: string;
  turn: number;
  startedAt: string;
}

const MAX_PROMPT_LENGTH = 2000;

// No fallback: only ever writes inside CLAUDE_PLUGIN_DATA (Claude Code's
// own per-plugin data directory — the officially documented mechanism for
// exactly this). Without it, there is nothing honest to write to.
function cacheDir(pluginDataDir?: string): string | undefined {
  return pluginDataDir ? path.join(pluginDataDir, 'turns') : undefined;
}

function cacheFile(sessionId: string, pluginDataDir?: string): string | undefined {
  const dir = cacheDir(pluginDataDir);
  if (!dir) return undefined;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(dir, `${safe}.json`);
}

export function truncatePrompt(prompt: string): string {
  return prompt.length > MAX_PROMPT_LENGTH ? `${prompt.slice(0, MAX_PROMPT_LENGTH)}…` : prompt;
}

// Call once per turn, from UserPromptSubmit. Mints a fresh span id and
// persists it (overwriting any previous turn's entry for this session) so
// this turn's PreToolUse calls can read it back. Returns the full turn entry.
function saveTurn(sessionId: string, entry: TurnCacheEntry, pluginDataDir?: string): void {
  const dir = cacheDir(pluginDataDir);
  const file = cacheFile(sessionId, pluginDataDir);
  if (!dir || !file) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
  } catch {
    // best effort — later hooks can reconstruct metadata from what they see
  }
}

export function startTurn(sessionId: string, prompt: string | undefined, pluginDataDir?: string): TurnCacheEntry {
  const previous = loadTurn(sessionId, pluginDataDir);
  const observedAt = new Date().toISOString();
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  const entry: TurnCacheEntry = {
    spanId,
    ...(prompt ? { prompt: truncatePrompt(prompt) } : {}),
    promptTimestamp: observedAt,
    turn: (previous?.turn || 0) + 1,
    startedAt: previous?.startedAt || observedAt,
  };
  saveTurn(sessionId, entry, pluginDataDir);
  return entry;
}

export function loadTurn(sessionId: string, pluginDataDir?: string): TurnCacheEntry | undefined {
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return undefined;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as TurnCacheEntry;
  } catch {
    return undefined;
  }
}

// Pre/Post hooks normally follow UserPromptSubmit. If a host invokes them
// without that boundary, record the first event we genuinely observed rather
// than fabricating session metadata or sending an invalid direct-AI request.
export function loadOrStartTurn(sessionId: string, pluginDataDir?: string): TurnCacheEntry {
  const existing = loadTurn(sessionId, pluginDataDir);
  if (existing?.turn && existing.startedAt && existing.promptTimestamp) return existing;
  return startTurn(sessionId, existing?.prompt, pluginDataDir);
}

export function directSessionFromTurn(sessionId: string, turn: TurnCacheEntry): DirectEvalSession {
  return { id: sessionId, turn: turn.turn, startedAt: turn.startedAt };
}

export function conversationFromTurn(turn: TurnCacheEntry): DirectEvalConversationMessage[] {
  if (!turn.prompt?.trim()) return [];
  return [
    {
      seq: 1,
      role: 'user',
      contentType: 'text/plain',
      content: turn.prompt,
      timestamp: turn.promptTimestamp,
    },
  ];
}
