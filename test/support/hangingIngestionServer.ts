import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

// Standalone process (not an in-process http.createServer) deliberately —
// same reason as delayedIngestionServer.ts: a mock hosted inside the test
// runner is unreachable from a spawnSync'd child under this environment's
// sandbox.
//
// Accepts every connection and never responds. Clients that honour
// AbortController therefore wait exactly until their own timeout, which is
// what sessionStart.test.ts needs to prove "one bounded wait, not several
// stacked." RFC 5737 TEST-NET addresses (e.g. 192.0.2.1) used to stand in
// for this, but many environments fail-fast (EPERM / ENETUNREACH) instead
// of hanging, which made the timing assertion flaky.

const server = http.createServer((_req, _res) => {
  // deliberately never respond
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${(server.address() as AddressInfo).port}\n`);
});
