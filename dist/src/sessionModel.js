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
exports.normalizeModel = normalizeModel;
exports.recordSessionModel = recordSessionModel;
exports.loadRecordedSessionModel = loadRecordedSessionModel;
exports.clearSessionModel = clearSessionModel;
exports.readLatestTranscriptModel = readLatestTranscriptModel;
exports.resolveSessionModel = resolveSessionModel;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
// Claude Code writes this placeholder model on locally generated assistant
// entries (API errors, interrupted requests) — not a model that ran anything.
const SYNTHETIC_MODEL = '<synthetic>';
// Only the tail of the transcript is scanned: it can grow to many MB over a
// long session, and this runs on every tool call. The newest assistant entry
// is almost always within the last few KB; 1 MiB leaves ample headroom for
// a large tool result written after it.
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;
function normalizeModel(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const model = raw.trim();
    if (!model || model === SYNTHETIC_MODEL)
        return undefined;
    return model;
}
// No fallback: only ever writes inside CLAUDE_PLUGIN_DATA. Without it the
// SessionStart value just isn't persisted; the transcript source still works.
function cacheFile(sessionId, pluginDataDir) {
    if (!pluginDataDir || !sessionId)
        return undefined;
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(pluginDataDir, 'session-models', `${safe}.json`);
}
function recordSessionModel(sessionId, rawModel, pluginDataDir, observedAt = new Date().toISOString()) {
    const model = normalizeModel(rawModel);
    const file = cacheFile(sessionId, pluginDataDir);
    if (!model || !file)
        return;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const entry = { model, observedAt };
        fs.writeFileSync(file, JSON.stringify(entry), 'utf8');
    }
    catch {
        // best effort — the transcript source can still supply the model
    }
}
function loadRecordedSessionModel(sessionId, pluginDataDir) {
    const file = cacheFile(sessionId, pluginDataDir);
    if (!file)
        return undefined;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const model = normalizeModel(parsed?.model);
        if (!model)
            return undefined;
        return { model, observedAt: typeof parsed.observedAt === 'string' ? parsed.observedAt : '' };
    }
    catch {
        return undefined;
    }
}
// Called from SessionEnd — local cleanup, so the directory doesn't grow one
// file per session forever.
function clearSessionModel(sessionId, pluginDataDir) {
    const file = cacheFile(sessionId, pluginDataDir);
    if (!file)
        return;
    try {
        fs.rmSync(file, { force: true });
    }
    catch {
        // best effort
    }
}
function readTail(filePath, maxBytes) {
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
    }
    finally {
        fs.closeSync(fd);
    }
}
// The newest main-thread assistant entry's model in the transcript, with
// that entry's own timestamp. Sidechain entries (a subagent's turns, when a
// host writes them inline) are skipped — they may run a different model
// than the session itself.
function readLatestTranscriptModel(transcriptPath) {
    if (!transcriptPath)
        return undefined;
    try {
        const lines = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES).split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (!line)
                continue;
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (entry?.type !== 'assistant' || entry.isSidechain === true)
                continue;
            const model = normalizeModel(entry.message?.model);
            if (!model)
                continue;
            return { model, observedAt: typeof entry.timestamp === 'string' ? entry.timestamp : '' };
        }
    }
    catch {
        // missing/unreadable transcript — fall through to the recorded value
    }
    return undefined;
}
function timeOf(iso) {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
}
function resolveSessionModel(sessionId, transcriptPath, pluginDataDir) {
    try {
        const recorded = loadRecordedSessionModel(sessionId, pluginDataDir);
        const fromTranscript = readLatestTranscriptModel(transcriptPath);
        if (fromTranscript && (!recorded || timeOf(fromTranscript.observedAt) >= timeOf(recorded.observedAt))) {
            return { model: fromTranscript.model, source: 'transcript' };
        }
        if (recorded)
            return { model: recorded.model, source: 'sessionStart' };
    }
    catch {
        // never let model resolution reach a fail-closed handler
    }
    return { source: 'none' };
}
