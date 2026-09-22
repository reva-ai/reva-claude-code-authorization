export interface RevaConfig {
  rtgUrl: string;
  // Sent as the X-API-Token header on BOTH evaluation and ingestion calls —
  // one Reva auth token authenticates everything this plugin does.
  authorization: string;
  // The Cedar `Agent` entity's id — the logged-in Anthropic account id
  // (oauthAccount.accountUuid), stable across every machine that account
  // uses. No fallback (see deviceId.ts's resolveAgentId): loadConfig()
  // throws if neither an OAuth account nor REVA_AGENT_ID is available, the
  // same as a missing auth token. The CodingAgent schema's `Agent` shape
  // has no name/description attributes, only a required `user` entity
  // reference — nothing else to configure.
  agentId: string;
  timeoutMs: number;
  // Ingestion API (registers User/Agent/MCPServer entities so they exist
  // before any evaluation request references them) — a separate base URL
  // and timeout from evaluation (best-effort, no user-facing value worth
  // waiting the same 25s default for), but the same `authorization` token.
  ingestionUrl: string;
  ingestionTimeoutMs: number;
}

export interface PreToolUseInput {
  session_id: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd: string;
  permission_mode?: string;
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, any>;
  // Populated by Claude Code when this tool call originates from inside a
  // Task-spawned subagent; absent for top-level session tool calls.
  agent_id?: string;
  agent_type?: string;
}

export interface PostToolUseInput extends PreToolUseInput {
  // Structured tool result (shape depends on the tool). Present after a
  // successful run; this is what PostToolUse puts in transmission.userQuery.
  tool_response?: unknown;
  tool_use_id?: string;
  duration_ms?: number;
}

export interface UserPromptSubmitInput {
  session_id: string;
  prompt_id?: string;
  cwd: string;
  hook_event_name: string;
  prompt: string;
}

// A bare reference to an entity — used for active-turn hops and as the base
// of direct-AI subject/principal/resource specs.
export interface CedarEntityRef {
  type: string;
  id: string;
}

// Canonical entity shape accepted by the direct AI evaluation endpoint.
// Request-local attributes ride in `properties`; the endpoint does not accept
// the classic evaluation API's top-level `entities` collection.
export interface DirectEvalEntitySpec extends CedarEntityRef {
  name?: string;
  properties?: Record<string, any>;
  // Request-local Cedar ancestry for ephemeral coding resources that are not
  // persisted in RTG (files, directories, tools, and subagents).
  parents?: CedarEntityRef[];
  tool?: string;
  origin?: string;
  endpoint?: string;
}

// Internal normalized entity description used by the mapping layer. Direct
// AI requests map attrs and optional ancestry onto the direct entity spec;
// RTG's stored bare User/Agent entities remain authoritative.
export interface CedarEntityDescriptor {
  uid: CedarEntityRef;
  attrs: Record<string, any>;
  parents: CedarEntityRef[];
}

// One step in the delegation chain leading up to (but not including) the
// current request's own action — see hopChain.ts for how this is tracked
// across the stateless per-hook-call processes.
export interface CedarHop {
  seq: number;
  subject: CedarEntityRef;
  action: { name: string };
  resource: CedarEntityRef;
  time: string;
}

export interface DirectEvalConversationMessage {
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  contentType: string;
  content: string;
  timestamp: string;
}

export interface DirectEvalTransmission {
  promptKey: 'userQuery';
  userQuery: string;
  role: 'user' | 'assistant' | 'tool';
  contentType: string;
}

// Metadata-only sessions are explicitly supported by RTG Edge. The plugin
// deliberately omits `messages`: its current hooks do not observe a reliable
// final assistant response for every completed turn, so adding history would
// fabricate evidence or create invalid request/response pairs.
export interface DirectEvalSession {
  id: string;
  turn: number;
  startedAt: string;
}

export interface CedarRequest {
  // subject: the entity directly performing this action (Machine/SubAgent
  // for tool calls, User for invokeAgent itself).
  subject: DirectEvalEntitySpec;
  // principal: the human who ultimately initiated this chain — always the
  // resolved user, even many hops/subagents deep. Equal to `subject` only
  // for invokeAgent, where the human IS the one directly acting.
  principal: DirectEvalEntitySpec;
  action: { name: string };
  resource: DirectEvalEntitySpec;
  context: Record<string, any>;
  transmission: DirectEvalTransmission;
  session: DirectEvalSession;
}

export type RtgDecision = 'allow' | 'deny' | 'ask';

export interface RtgResult {
  decision: RtgDecision;
  // Set only for 401 and 413 (see rtgClient.ts's handleOperationalStatuses)
  // — the two statuses that still fail open. Hook writers must emit no
  // Claude decision in this state: emitting an explicit `allow` would
  // bypass Claude Code's own normal permission prompt. Every other
  // operational failure (404/424/429/5xx/transport failures) now fails
  // closed instead — an active `deny` that must reach Claude Code, so
  // `inactive` is never set alongside those.
  inactive?: boolean;
  reason?: string;
  raw?: any;
  // Opaque machine-readable error supplied by RTG Edge, or a synthetic
  // RTG_UNAVAILABLE/RTG_TIMEOUT for a transport failure/timeout.
  errorType?: string;
  // The actual RTG HTTP status, or synthetic 503/504 for a transport
  // failure/timeout. Kept separate from the Claude Code hook decision.
  status?: number;
}

export type CedarActionName =
  | 'executeBash'
  | 'read'
  | 'write'
  | 'edit'
  | 'glob'
  | 'grep'
  | 'invokeTool'
  | 'spawn'
  | 'invokeAgent';

export interface CedarActionMapping {
  actionName: CedarActionName;
  resourceType: string;
  resourceId: string;
  resourceProperties?: Record<string, any>;
  resourceParents?: CedarEntityRef[];
  // Only set for executeBash: the literal, real shell command string.
  command?: string;
  // Only set for glob/grep: the search pattern (there's no shell command
  // for these, but the pattern itself is meaningful context).
  pattern?: string;
  // Original Claude Code tool name (e.g. "MultiEdit", "NotebookEdit") for
  // actions that group multiple tools together (edit covers Edit/MultiEdit/
  // NotebookEdit) — keeps audit fidelity without needing a separate action
  // per tool variant.
  tool?: string;
}

export interface SessionContext {
  id: string;
  traceId: string;
  spanId: string;
}
