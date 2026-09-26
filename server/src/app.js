import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { auditRoutes } from './routes/auditRoutes.js';
import { HttpError } from './lib/errors.js';
import { silentLogger } from './lib/logger.js';

/** Resolve the tenant from `x-tenant-id` (stand-in for an auth token claim). */
function tenantScope(defaultTenantId) {
  return (req, res, next) => {
    const tenantId = req.get('x-tenant-id') || defaultTenantId;
    if (!mongoose.isValidObjectId(tenantId)) return next(new HttpError(400, 'Invalid x-tenant-id'));
    req.tenantId = tenantId;
    next();
  };
}

export function createApp({
  controller,
  worker,
  aiService,
  defaultTenantId,
  runtime = 'server', // 'server' (long-lived worker + SSE) | 'serverless' (drain on demand + polling)
  logger = silentLogger,
  staticDir = null,
}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '100kb' }));

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      runtime,
      db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      ai: aiService?.describe(),
      worker: worker ? { id: worker.workerId, running: worker.running, concurrency: worker.concurrency, stats: worker.stats } : null,
    });
  });

  // Kick the queue: processes ready jobs within a bounded time budget. The
  // long-lived worker it is harmless (claims are atomic); on serverless it is how work runs
  // (triggered after writes via waitUntil, and by dashboards while polling).
  app.post('/api/worker/drain', async (req, res) => {
    const processed = await worker.drain({ budgetMs: runtime === 'serverless' ? 25_000 : 5_000 });
    res.json({ processed, stats: worker.stats });
  });

  if (runtime === 'serverless') {
    // Function instances don't share memory, so an SSE stream would miss
    // events from other instances. Clients poll instead (see /api/health).
    app.get('/api/audit-entries/events', (req, res) =>
      res.status(501).json({ error: 'Live stream unavailable on serverless; poll the list endpoint' }),
    );
  }

  app.use('/api/audit-entries', tenantScope(defaultTenantId), auditRoutes(controller));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  if (staticDir && fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) logger.error(err.stack || String(err));
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message, details: err.details });
  });

  return app;
}
