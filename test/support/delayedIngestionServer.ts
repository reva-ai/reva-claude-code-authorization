import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

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
    res.end(
      JSON.stringify([
        { id: 'user-type', name: 'User', schemaName: 's' },
        { id: 'agent-type', name: 'Agent', schemaName: 's' },
        { id: 'mcp-type', name: 'MCPServer', schemaName: 's' },
      ]),
    );
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
  process.stdout.write(`${(server.address() as AddressInfo).port}\n`);
});
