import path from 'node:path';
import config, { ROOT_DIR } from './config/index.js';
import { connectDatabase, disconnectDatabase } from './db/connection.js';
import { AuditEntry } from './models/AuditEntry.js';
import { buildContainer } from './container.js';
import { createLogger } from './lib/logger.js';
import { createApp } from './app.js';

const log = createLogger('server');

async function main() {
  await connectDatabase();
  await AuditEntry.syncIndexes();

  const { controller, worker, aiService } = buildContainer();
  const app = createApp({
    controller,
    worker,
    aiService,
    runtime: 'server',
    defaultTenantId: config.defaultTenantId,
    logger: log,
    staticDir: path.join(ROOT_DIR, 'client', 'dist'),
  });

  const server = app.listen(config.port, () => log.info(`API listening on http://localhost:${config.port}`));
  worker.start();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, draining...`);
    server.closeAllConnections?.();
    server.close();
    await worker.stop(); // lets in-flight jobs commit; unfinished leases expire and are reclaimed
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error(`fatal: ${err.stack || err}`);
  process.exit(1);
});
