import { createHash } from 'node:crypto';
import { SessionContext } from './types';

// traceId is deterministic per session_id (stable across the many separate
// hook process invocations that make up one Claude Code session). spanId is
// NOT derived here — it's minted once per turn by turnCache.startTurn and
// passed in, so every call within one turn shares the identical traceparent
// and a new turn always gets a new one.
export function buildTraceId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

export function buildSessionContext(sessionId: string, spanId: string, id?: string): SessionContext {
  return { id: id || sessionId, traceId: buildTraceId(sessionId), spanId };
}

export function traceparentHeader(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}
