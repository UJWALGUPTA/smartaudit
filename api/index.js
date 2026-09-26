/**
 * Vercel serverless entry. Same Express app and classes as `npm run dev`,
 * but without a long-lived worker: queued jobs are drained after the
 * response via waitUntil (and by polling dashboards via /api/worker/drain).
 */
import { waitUntil } from '@vercel/functions';
import config from '../server/src/config/index.js';
import { connectDatabase } from '../server/src/db/connection.js';
import { buildContainer } from '../server/src/container.js';
import { createApp } from '../server/src/app.js';
import { createLogger } from '../server/src/lib/logger.js';

const log = createLogger('vercel');
const { controller, worker, aiService, eventBus } = buildContainer();

// A write queued AI work: keep this invocation alive after responding and
// process the queue within the function's time budget.
eventBus.on('entry.queued', () => waitUntil(worker.drain({ budgetMs: 40_000 })));

const app = createApp({
  controller,
  worker,
  aiService,
  runtime: 'serverless',
  defaultTenantId: config.defaultTenantId,
  logger: log,
});

let ready = null; // connection is reused across warm invocations

export default async function handler(req, res) {
  try {
    ready ??= connectDatabase().catch((err) => {
      ready = null;
      throw err;
    });
    await ready;
  } catch (err) {
    log.error(`database unavailable: ${err.message}`);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'Database unavailable' }));
  }
  return app(req, res);
}
