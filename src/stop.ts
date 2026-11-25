import { resolveAssistantOutput } from './assistantOutput';
import { loadConfig } from './config';
import { debugLog } from './debug';
import { summarizeTrace } from './rtgClient';
import { skipOutsideCodeScope } from './runtimeScope';
import { readStdin } from './stdin';
import { loadTurn, resolveTurnTraceId } from './turnCache';

// Stop fires when Claude finishes a response for the current turn. That is
// the natural close of one prompt-trace: evaluate already recorded hops;
// summarize asks RTG to write the trace summary. Best-effort — a failed
// summarize must never block or alter Claude's stop behavior.
interface StopInput {
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
  // Final assistant text for this turn (Claude Code ≥2.1.47). Prefer this
  // over parsing transcript_path — the JSONL can lag one turn behind Stop.
  last_assistant_message?: string;
}

async function main(): Promise<void> {
  if (skipOutsideCodeScope()) return;
  const raw = await readStdin();
  const input: StopInput = JSON.parse(raw);
  const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;

  try {
    const cfg = loadConfig();
    const turn = loadTurn(input.session_id, pluginDataDir);
    if (!turn) {
      debugLog('stop: skip summarize — no turn cache entry');
      process.exit(0);
    }

    const output = resolveAssistantOutput({
      lastAssistantMessage: input.last_assistant_message,
      transcriptPath: input.transcript_path,
    });
    if (!output) debugLog('stop: no assistant output available for summarize');

    const traceId = resolveTurnTraceId(input.session_id, turn);
    const result = await summarizeTrace(cfg, {
      trace_id: traceId,
      thread_id: input.session_id,
      ...(output ? { output } : {}),
    });
    if (result.ok) {
      debugLog(
        `stop: summarize accepted for trace_id=${traceId} output_bytes=${Buffer.byteLength(output || '', 'utf8')}`,
      );
    } else {
      debugLog(
        `stop: summarize failed status=${result.status ?? 'n/a'} reason=${result.reason || 'unknown'}`,
      );
    }
  } catch (err: any) {
    debugLog(`stop: unexpected error — continuing (${err?.message || String(err)})`);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));
