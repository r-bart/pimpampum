#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createHttpClient, type PimpampumHttpClient } from './client.js';
import { createLazyGateway } from './cliProgram.js';
import { createClientConfigResolver, missingDaemonTokenError, tokenPathOf } from './config.js';
import { buildMcpServer } from './mcp.js';

// A client reads the token the daemon minted; it never mints one itself. The bridge may outlive
// the daemon's first start, so the token is re-read on every call until it exists: the host needs
// no restart, and while it is still missing each call fails `unavailable` naming the token path.
const resolveConfig = createClientConfigResolver();
const initial = resolveConfig();
if (initial.token === '') {
  console.error(
    `Pimpampum stdio bridge: no daemon token at ${tokenPathOf(initial.dataDirectory)}. Run \`pimpampum status\`; if the service is not installed, run \`pimpampum install\`.`,
  );
}
let current: { token: string; client: PimpampumHttpClient } | null = null;
const gateway = createLazyGateway((): PimpampumHttpClient => {
  const config = resolveConfig();
  if (config.token === '') throw missingDaemonTokenError(config.dataDirectory);
  if (current === null || current.token !== config.token) {
    current = { token: config.token, client: createHttpClient(config) };
  }
  return current.client;
});
const handle = serveStdio(() => buildMcpServer(gateway), {
  onerror: (error) => console.error('Pimpampum stdio bridge failed', error),
});

const shutdown = async () => {
  await handle.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
