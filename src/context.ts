import { ActiveSession } from './activeSessions';
import { AGENT_TYPE } from './ingestionClient';
import {
  CedarActionMapping,
  CedarHop,
  DirectEvalConversationMessage,
  DirectEvalTransmission,
} from './types';

// The CodingAgent Cedar schema declares a DIFFERENT context shape per
// action — Cedar treats context records as closed, so sending an attribute
// an action doesn't declare is a schema violation, not a harmless extra
// field. The direct-AI endpoint projects `conversation` and `hops` out as
// active-turn evidence before validating the remaining managed context.
//
// `prompt` is deliberately NOT sent in `context` — the PDP now manages
// that field itself (derived server-side from `transmission`) and rejects
// any request that echoes it back: "invalid Cedar context: managed context
// field \"prompt\" is reserved for the Reva platform". The prompt/current
// action content still reaches the PDP, just exclusively via the top-level
// `transmission` field (see buildTransmission/buildToolResponseTransmission
// below) rather than duplicated into context. `timestamp` (epoch
// milliseconds UTC, a Long — Date.now() already is exactly this, no
// timezone handling needed) is unaffected and still sent on every action.
//
// NOTE: as of the last confirmed schema, `timestamp` was only declared for
// invokeAgent/invokeTool/invokeModel — NOT for spawn/executeBash/read/
// write/edit/glob/grep. Sending it on those without a matching schema
// update is exactly the kind of closed-context violation this file exists
// to avoid — confirm those actions' schemas now also declare `timestamp`
// before relying on this in production.
//
// Current shape per action:
//   invokeAgent:          { timestamp (required), hops: [] }
//   invokeTool:           { timestamp (required) }
//   spawn:                { timestamp, subagentIndex (required) }
//   executeBash:          { timestamp, command (required, real shell string) }
//   read / write / edit / glob / grep: { timestamp }
//
// invokeModel and listTools are also declared in the schema but have no
// Claude Code hook boundary to gate them from (no "about to call the
// model" or "about to list tools" hook exists) — not implemented here.
//
// activeSessionCount/sessionId/sessionEntryPoint/sessionLastSeen are sent on
// every action (same everywhere-precedent as timestamp) — local-machine-only
// visibility into how many Claude Code sessions are concurrently running for
// this Agent right now (see activeSessions.ts). Kept to plain scalars
// deliberately: a Set<Record> was rejected ("managed context supports only
// homogeneous scalar sets"), and a Set<String> of every active session id
// still isn't as simple as it should be for policy authors — so this only
// reports the CURRENT session's own three fields plus the aggregate count,
// not the full list of who else is active.
//
// agentType is also sent on every action, alongside those — the same
// AGENT_TYPE constant ingestionClient.ts sends as the Agent entity's own
// agentType attribute (see the comment there for why it's a hardcoded
// constant, not runtime-detected).
export interface ActionContextExtras {
  // Cumulative count of subagents spawned so far this session (1 = first
  // spawn) — only meaningful for, and only sent on, the spawn action.
  subagentIndex?: number;
  // Completed lineage before the current action. Top-level
  // subject/action/resource/transmission describe the current action, so it
  // must not be duplicated here.
  hops?: CedarHop[];
  conversationMessages?: DirectEvalConversationMessage[];
  // How many sessions are currently active on this machine, including the
  // one making this very request — so 1 means nothing else is running
  // right now. Local-only: no visibility into other machines, even ones
  // signed into the same account.
  activeSessionCount?: number;
  // This request's own session — its id/entrypoint/lastSeen, the same
  // entry markSessionActive() just wrote (or getSessionEntry() read back).
  currentSession?: ActiveSession;
}

function activeTurnEvidence(extras: ActionContextExtras): Record<string, any> {
  const messages = extras.conversationMessages || [];
  return {
    // Canonical direct-AI placement. An empty array is meaningful for the
    // first hop of a turn and keeps every request on one stable shape.
    hops: extras.hops || [],
    ...(messages.length > 0 ? { conversation: { messages } } : {}),
  };
}

function activeSessionFields(extras: ActionContextExtras): Record<string, any> {
  return {
    activeSessionCount: extras.activeSessionCount ?? 0,
    sessionId: extras.currentSession?.sessionId ?? '',
    sessionEntryPoint: extras.currentSession?.entrypoint ?? '',
    sessionLastSeen: extras.currentSession?.lastSeen ?? 0,
    agentType: AGENT_TYPE,
  };
}

export function buildActionContext(
  mapping: CedarActionMapping,
  extras: ActionContextExtras = {},
): Record<string, any> {
  const timestamp = Date.now();
  const evidence = activeTurnEvidence(extras);
  const sessions = activeSessionFields(extras);
  switch (mapping.actionName) {
    case 'invokeTool':
      return { timestamp, ...evidence, ...sessions };
    case 'spawn':
      return { timestamp, subagentIndex: extras.subagentIndex ?? 1, ...evidence, ...sessions };
    case 'executeBash':
      return { timestamp, command: mapping.command ?? '', ...evidence, ...sessions };
    case 'read':
    case 'write':
    case 'edit':
    case 'glob':
    case 'grep':
      return { timestamp, ...evidence, ...sessions };
    default:
      return { timestamp, ...evidence, ...sessions };
  }
}

export function buildInvokeAgentContext(activeSessionCount = 0, currentSession?: ActiveSession): Record<string, any> {
  return { timestamp: Date.now(), hops: [], ...activeSessionFields({ activeSessionCount, currentSession }) };
}

// `role`/`contentType`/`promptKey` are constants here — Claude Code doesn't
// expose a multi-role or multi-content-type concept at the hook level, only
// ever the current turn's plain-text prompt.
export function buildTransmission(
  content: string,
  role: DirectEvalTransmission['role'],
  nonblankFallback?: string,
): DirectEvalTransmission {
  const userQuery = content.trim() ? content : (nonblankFallback || '').trim();
  if (!userQuery) {
    throw new Error('direct AI evaluation requires a nonblank current prompt');
  }
  return { promptKey: 'userQuery', userQuery, role, contentType: 'text/plain' };
}

const MAX_TOOL_RESPONSE_LENGTH = 2000;

export function serializeToolResponse(toolResponse: unknown): string {
  if (toolResponse == null) return '';
  const raw = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse);
  return raw.length > MAX_TOOL_RESPONSE_LENGTH ? `${raw.slice(0, MAX_TOOL_RESPONSE_LENGTH)}…` : raw;
}

// PostToolUse: the tool has already returned, so transmission carries that
// result (role "tool") instead of the user prompt. context no longer
// carries a `prompt` field at all — that's now PDP-managed, not client-set.
export function buildToolResponseTransmission(toolResponse: unknown, nonblankFallback: string): DirectEvalTransmission {
  const content = serializeToolResponse(toolResponse);
  const transmission = buildTransmission(content, 'tool', nonblankFallback);
  transmission.contentType =
    content && typeof toolResponse !== 'string' && toolResponse != null ? 'application/json' : 'text/plain';
  return transmission;
}
