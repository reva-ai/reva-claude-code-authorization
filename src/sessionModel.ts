import * as fs from 'node:fs';
import * as path from 'node:path';

// Which Claude model this session is running on, so every decision log
// records it as context.model (see context.ts). Two real sources, no guess:
//
//   1. SessionStart's own `model` field — the model the session started on.
//      SessionStart is the ONLY hook whose payload carries it, and every
//      other hook is a separate stateless process, so it is persisted here
//      (under CLAUDE_PLUGIN_DATA, same no-fallback rule as turnCache.ts) for
//      the later hooks to read back.
//   2. The transcript JSONL (`transcript_path`, on every hook payload): each
//      assistant entry carries `message.model` — the model that ACTUALLY
//      produced that response — plus an ISO `timestamp`. This is what keeps
//      the value right after a mid-session `/model` switch, which no hook
//      announces.
//
// Whichever of the two was observed more recently wins. That ordering
// matters on `--resume`: the transcript's last assistant entry is from the
// previous run (possibly another model), while SessionStart just reported
// the model this run actually starts on.
//
// Known limits, stated rather than papered over:
//   - After a `/model` switch, the value updates on the first response the
//     new model writes to the transcript; the prompt evaluated in between
//     still reports the previous model.
//   - A subagent's own tool calls report the parent session's model — the
//     hook payload gives no confirmed path to the subagent's own transcript.
//
// Best-effort throughout: every function here swallows its own errors and
// returns undefined. authorize.ts/authorizePost.ts/authorizePrompt.ts fail
// CLOSED on an uncaught throw, and a missing model is never worth denying a
// real action over — it is simply left out of the request.

export interface SessionModelEntry {
  model: string;
  // ISO time the model was observed — compared against the transcript's
  // own entry timestamps to decide which source is newer.
  observedAt: string;
}

export interface ResolvedSessionModel {
  model?: string;
  source: 'transcript' | 'sessionStart' | 'none';
}

// Claude Code writes this placeholder model on locally generated assistant
// entries (API errors, interrupted requests) — not a model that ran anything.
const SYNTHETIC_MODEL = '<synthetic>';

// Only the tail of the transcript is scanned: it can grow to many MB over a
// long session, and this runs on every tool call. The newest assistant entry
// is almost always within the last few KB; 1 MiB leaves ample headroom for
// a large tool result written after it.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

export function normalizeModel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const model = raw.trim();
  if (!model || model === SYNTHETIC_MODEL) return undefined;
  return model;
}

// No fallback: only ever writes inside CLAUDE_PLUGIN_DATA. Without it the
// SessionStart value just isn't persisted; the transcript source still works.
function cacheFile(sessionId: string, pluginDataDir?: string): string | undefined {
  if (!pluginDataDir || !sessionId) return undefined;
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(pluginDataDir, 'session-models', `${safe}.json`);
}

export function recordSessionModel(
  sessionId: string,
  rawModel: unknown,
  pluginDataDir?: string,
  observedAt: string = new Date().toISOString(),
): void {
  const model = normalizeModel(rawModel);
  const file = cacheFile(sessionId, pluginDataDir);
  if (!model || !file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry: SessionModelEntry = { model, observedAt };
    fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
  } catch {
    // best effort — the transcript source can still supply the model
  }
}

export function loadRecordedSessionModel(sessionId: string, pluginDataDir?: string): SessionModelEntry | undefined {
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const model = normalizeModel(parsed?.model);
    if (!model) return undefined;
    return { model, observedAt: typeof parsed.observedAt === 'string' ? parsed.observedAt : '' };
  } catch {
    return undefined;
  }
}

// Called from SessionEnd — local cleanup, so the directory doesn't grow one
// file per session forever.
export function clearSessionModel(sessionId: string, pluginDataDir?: string): void {
  const file = cacheFile(sessionId, pluginDataDir);
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort
  }
}

function readTail(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const text = buf.toString('utf8');
    // A cut mid-file almost certainly split the first line — drop it rather
    // than try to parse a fragment.
    return length < size ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

// The newest main-thread assistant entry's model in the transcript, with
// that entry's own timestamp. Sidechain entries (a subagent's turns, when a
// host writes them inline) are skipped — they may run a different model
// than the session itself.
export function readLatestTranscriptModel(transcriptPath?: string): SessionModelEntry | undefined {
  if (!transcriptPath) return undefined;
  try {
    const lines = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES).split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== 'assistant' || entry.isSidechain === true) continue;
      const model = normalizeModel(entry.message?.model);
      if (!model) continue;
      return { model, observedAt: typeof entry.timestamp === 'string' ? entry.timestamp : '' };
    }
  } catch {
    // missing/unreadable transcript — fall through to the recorded value
  }
  return undefined;
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export function resolveSessionModel(
  sessionId: string,
  transcriptPath: string | undefined,
  pluginDataDir?: string,
): ResolvedSessionModel {
  try {
    const recorded = loadRecordedSessionModel(sessionId, pluginDataDir);
    const fromTranscript = readLatestTranscriptModel(transcriptPath);
    if (fromTranscript && (!recorded || timeOf(fromTranscript.observedAt) >= timeOf(recorded.observedAt))) {
      return { model: fromTranscript.model, source: 'transcript' };
    }
    if (recorded) return { model: recorded.model, source: 'sessionStart' };
  } catch {
    // never let model resolution reach a fail-closed handler
  }
  return { source: 'none' };
}
