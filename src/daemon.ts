import { startServer } from './server.js';

const running = await startServer();
console.log(`Pimpampum listening on ${running.config.baseUrl}`);

const shutdown = async () => {
  await running.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
