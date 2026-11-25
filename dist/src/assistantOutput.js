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
exports.truncateAssistantOutput = truncateAssistantOutput;
exports.resolveAssistantOutput = resolveAssistantOutput;
const fs = __importStar(require("node:fs"));
// RTG truncates the stored output at 16 KiB. Stay under that so summarize is
// not rejected as invalid.
const MAX_OUTPUT_BYTES = 16 * 1024;
/** Truncate to RTG's stored-output budget (UTF-8 byte length). */
function truncateAssistantOutput(text) {
    const trimmed = (text || '').trim();
    if (!trimmed)
        return '';
    const buf = Buffer.from(trimmed, 'utf8');
    if (buf.length <= MAX_OUTPUT_BYTES)
        return trimmed;
    return buf.subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
}
/**
 * Prefer Stop's last_assistant_message (race-free). Fall back to the last
 * assistant text in the transcript JSONL when that field is missing (older
 * hosts / SessionEnd / prior-turn close).
 */
function resolveAssistantOutput(opts) {
    const fromHook = truncateAssistantOutput(opts.lastAssistantMessage);
    if (fromHook)
        return fromHook;
    return truncateAssistantOutput(readLastAssistantFromTranscript(opts.transcriptPath));
}
function readLastAssistantFromTranscript(transcriptPath) {
    if (!transcriptPath)
        return '';
    try {
        const raw = fs.readFileSync(transcriptPath, 'utf8');
        const lines = raw.split('\n');
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
            const text = assistantTextFromTranscriptEntry(entry);
            if (text)
                return text;
        }
    }
    catch {
        // best-effort — summarize still works without output
    }
    return '';
}
function assistantTextFromTranscriptEntry(entry) {
    if (!entry || typeof entry !== 'object')
        return '';
    // Common Claude Code JSONL shapes: message.role / type + message.content
    const role = entry.role || entry.message?.role || entry.type;
    if (role !== 'assistant' && entry.type !== 'assistant')
        return '';
    const content = entry.message?.content ?? entry.content;
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        if (typeof block === 'string')
            parts.push(block);
        else if (block && typeof block.text === 'string')
            parts.push(block.text);
    }
    return parts.join('\n').trim();
}
