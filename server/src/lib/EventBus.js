import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub between the API, the worker and SSE clients.
 *
 *   entry.queued  -> a record became PENDING; wakes idle worker slots early
 *   entry.changed -> any state change; fanned out to dashboards over SSE
 *
 * Single-process by design. With multiple API/worker instances this would be
 * backed by MongoDB change streams or Redis pub/sub; nothing correctness-
 * critical depends on it (the worker still polls, dashboards still refetch).
 */
export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  queued(entry) {
    this.emit('entry.queued', { id: String(entry._id), tenantId: String(entry.tenantId) });
  }

  changed(entry, reason) {
    this.emit('entry.changed', {
      id: String(entry._id),
      tenantId: String(entry.tenantId),
      status: entry.aiMetadata?.status,
      reason,
      at: new Date().toISOString(),
    });
  }
}
