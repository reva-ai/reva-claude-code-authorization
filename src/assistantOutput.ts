import * as fs from 'node:fs';

// RTG truncates the stored output at 16 KiB. Stay under that so summarize is
// not rejected as invalid.
const MAX_OUTPUT_BYTES = 16 * 1024;

/** Truncate to RTG's stored-output budget (UTF-8 byte length). */
export function truncateAssistantOutput(text: string | undefined | null): string {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  const buf = Buffer.from(trimmed, 'utf8');
  if (buf.length <= MAX_OUTPUT_BYTES) return trimmed;
  return buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
}

/**
 * Prefer Stop's last_assistant_message (race-free). Fall back to the last
 * assistant text in the transcript JSONL when that field is missing (older
 * hosts / SessionEnd / prior-turn close).
 */
export function resolveAssistantOutput(opts: {
  lastAssistantMessage?: string;
  transcriptPath?: string;
}): string {
  const fromHook = truncateAssistantOutput(opts.lastAssistantMessage);
  if (fromHook) return fromHook;
  return truncateAssistantOutput(readLastAssistantFromTranscript(opts.transcriptPath));
}

function readLastAssistantFromTranscript(transcriptPath?: string): string {
  if (!transcriptPath) return '';
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const text = assistantTextFromTranscriptEntry(entry);
      if (text) return text;
    }
  } catch {
    // best-effort — summarize still works without output
  }
  return '';
}

function assistantTextFromTranscriptEntry(entry: any): string {
  if (!entry || typeof entry !== 'object') return '';
  // Common Claude Code JSONL shapes: message.role / type + message.content
  const role = entry.role || entry.message?.role || entry.type;
  if (role !== 'assistant' && entry.type !== 'assistant') return '';
  const content = entry.message?.content ?? entry.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}
