import config from './config/index.js';
import { AuditRepository } from './repositories/AuditRepository.js';
import { AIService } from './services/ai/AIService.js';
import { AIWorkerService } from './services/AIWorkerService.js';
import { AuditController } from './controllers/AuditController.js';
import { EventBus } from './lib/EventBus.js';
import { createLogger } from './lib/logger.js';

/** Wires the object graph once; shared by the long-lived server and the Vercel function. */
export function buildContainer() {
  const eventBus = new EventBus();
  const repository = new AuditRepository();
  const aiService = AIService.fromConfig(config.ai, createLogger('ai'));
  const worker = new AIWorkerService({
    repository,
    aiService,
    eventBus,
    logger: createLogger('worker'),
    ...config.worker,
  });
  const controller = new AuditController({ repository, eventBus, worker, logger: createLogger('api') });
  return { eventBus, repository, aiService, worker, controller };
}
