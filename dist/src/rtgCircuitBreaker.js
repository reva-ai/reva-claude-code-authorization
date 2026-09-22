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
exports.checkCircuitBreaker = checkCircuitBreaker;
exports.tripCircuitBreaker = tripCircuitBreaker;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
// No fallback: only ever writes inside CLAUDE_PLUGIN_DATA, same as every
// other local state file in this plugin.
function cacheDir(pluginDataDir) {
    return pluginDataDir ? path.join(pluginDataDir, 'rtg-circuit-breaker') : undefined;
}
function cacheFile(agentId, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    if (!dir)
        return undefined;
    const safe = agentId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(dir, `${safe}.json`);
}
// Read-only: an expired window is just reported as not-disabled, not
// deleted — the next tripCircuitBreaker() call overwrites the file
// regardless, so there's nothing to clean up here.
function checkCircuitBreaker(agentId, pluginDataDir) {
    const file = cacheFile(agentId, pluginDataDir);
    if (!file)
        return { disabled: false };
    try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof state.disabledUntil === 'number' && Date.now() < state.disabledUntil) {
            return {
                disabled: true,
                disabledUntil: state.disabledUntil,
                triggeredStatus: state.triggeredStatus,
                errorType: state.errorType,
            };
        }
        return { disabled: false };
    }
    catch {
        return { disabled: false };
    }
}
// Opens (or extends/replaces) the breaker for durationMs from now, called
// right after a 401 response — the only status that currently triggers it
// (see rtgClient.ts).
function tripCircuitBreaker(agentId, durationMs, triggeredStatus, errorType, pluginDataDir) {
    const dir = cacheDir(pluginDataDir);
    const file = cacheFile(agentId, pluginDataDir);
    if (!dir || !file)
        return;
    const state = { disabledUntil: Date.now() + durationMs, triggeredStatus, errorType };
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(state), 'utf8');
    }
    catch {
        // best effort — worst case the next few calls just hit the RTG for
        // real instead of short-circuiting
    }
}
