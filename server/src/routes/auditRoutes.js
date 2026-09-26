import { Router } from 'express';

export function auditRoutes(controller) {
  const router = Router();
  router.get('/events', controller.events);
  router.get('/', controller.list);
  router.post('/', controller.create);
  router.get('/:id', controller.get);
  router.put('/:id', controller.update);
  router.post('/:id/similar', controller.similar);
  router.post('/:id/retry', controller.retry);
  return router;
}
