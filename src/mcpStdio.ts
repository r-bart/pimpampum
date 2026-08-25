#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createHttpClient } from './client.js';
import { loadConfig } from './config.js';
import { buildMcpServer } from './mcp.js';

const client = createHttpClient(loadConfig());
const handle = serveStdio(() => buildMcpServer(client), {
  onerror: (error) => console.error('Pimpampum stdio bridge failed', error),
});

const shutdown = async () => {
  await handle.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
