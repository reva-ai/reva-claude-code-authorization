"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveUserEmail = resolveUserEmail;
exports.resolveAgentContext = resolveAgentContext;
const os = __importStar(require("node:os"));
const deviceId_1 = require("./deviceId");
// Resolves the human principal's identity: the logged-in Anthropic account
// email from ~/.claude.json (fetched at OAuth login), then OS username as a
// last resort when Claude Code is not signed in.
function resolveUserEmail() {
    const oauthEmail = (0, deviceId_1.readOauthEmail)();
    if (oauthEmail)
        return oauthEmail;
    try {
        return os.userInfo().username;
    }
    catch {
        return 'unknown-user';
    }
}
// Claude Code populates agent_id/agent_type on the hook input when a tool
// call originates from inside a Task-spawned subagent; their absence means
// this is a top-level session tool call.
function resolveAgentContext(configuredAgentId, hookInput) {
    const isSubAgent = Boolean(hookInput.agent_id);
    return {
        agentId: configuredAgentId,
        isSubAgent,
        subAgentId: hookInput.agent_id,
        subAgentType: hookInput.agent_type,
    };
}
