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
const http = __importStar(require("node:http"));
// Standalone process (not an in-process http.createServer) deliberately —
// a mock server hosted inside the test runner's own process is unreachable
// from a spawnSync'd child in this environment's sandbox, even though it's
// plain loopback TCP. Run as its own OS process, same as the real Reva
// tenant sessionStart.js actually talks to, sidesteps that entirely.
//
// Prints its listening port as a single line on stdout, then serves:
//   GET  /ingestion/v2/policy-store/entity-types -> fast 200, a full catalog
//   GET  /ingestion/v2/entity/:id                -> delayed 404 (not found)
//   anything else                                -> fast 200 {}
// The delayed 404 drives ingestUser/ingestAgent into their POST-to-create
// branch, same as a genuinely new User/Agent on a real tenant — used to
// prove User and Agent ingestion run concurrently (see sessionStart.test.ts).
const delayMs = Number(process.argv[2] || '1000');
const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/ingestion/v2/policy-store/entity-types') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
            { id: 'user-type', name: 'User', schemaName: 's' },
            { id: 'agent-type', name: 'Agent', schemaName: 's' },
            { id: 'mcp-type', name: 'MCPServer', schemaName: 's' },
        ]));
        return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/ingestion/v2/entity/')) {
        setTimeout(() => {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
        }, delayMs);
        return;
    }
    req.resume();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
});
server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`${server.address().port}\n`);
});
