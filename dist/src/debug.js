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
exports.debugLog = debugLog;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
// Opt-in via REVA_DEBUG=1. Always writes to stderr (unmodified — a live
// terminal watching a hook run directly still sees exactly this). Also
// appends a timestamped copy to CLAUDE_PLUGIN_DATA/debug.log when that's
// set: stderr alone isn't enough for a hook invoked by the Desktop app
// (Chat/Cowork) rather than a terminal, since there's no confirmed way to
// know whether — or where — that stderr gets captured. The file is the
// one destination guaranteed to be checkable afterward, regardless of what
// actually ran the hook. Timestamped here specifically because this file
// accumulates across every hook invocation, across every session, not just
// one live-watched run — stderr's own line stays untimestamped since nothing
// else about its format has changed.
function debugLog(message) {
    if (!process.env.REVA_DEBUG)
        return;
    process.stderr.write(`[reva-security] ${message}\n`);
    const pluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
    if (!pluginDataDir)
        return;
    try {
        fs.mkdirSync(pluginDataDir, { recursive: true });
        fs.appendFileSync(path.join(pluginDataDir, 'debug.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
    }
    catch {
        // best effort — this plugin's own logging must never itself crash a hook
    }
}
