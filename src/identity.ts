import * as os from 'node:os';
import { readOauthEmail } from './deviceId';

// Resolves the human principal's identity: the logged-in Anthropic account
// email from ~/.claude.json (fetched at OAuth login), then OS username as a
// last resort when Claude Code is not signed in.
export function resolveUserEmail(): string {
  const oauthEmail = readOauthEmail();
  if (oauthEmail) return oauthEmail;
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown-user';
  }
}

// "AgentContext" here means "the calling entity's context" (main session vs
// subagent) — a naming coincidence with the Cedar `Agent` entity type, not
// a reference to it; don't conflate the two.
export interface AgentContext {
  agentId: string;
  isSubAgent: boolean;
  subAgentId?: string;
  subAgentType?: string;
}

// Claude Code populates agent_id/agent_type on the hook input when a tool
// call originates from inside a Task-spawned subagent; their absence means
// this is a top-level session tool call.
export function resolveAgentContext(
  configuredAgentId: string,
  hookInput: { agent_id?: string; agent_type?: string },
): AgentContext {
  const isSubAgent = Boolean(hookInput.agent_id);
  return {
    agentId: configuredAgentId,
    isSubAgent,
    subAgentId: hookInput.agent_id,
    subAgentType: hookInput.agent_type,
  };
}
