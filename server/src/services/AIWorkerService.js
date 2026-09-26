import os from 'node:os';
import crypto from 'node:crypto';
import { silentLogger } from '../lib/logger.js';

/**
 * Background enrichment worker. MongoDB itself is the queue:
 *
 *   claim    findOneAndUpdate PENDING -> PROCESSING with a lease (lockedBy/lockedUntil)
 *   enrich   AIService call(s), outside any lock or transaction
 *   commit   updateOne guarded by {coreRevision, lockedBy}; a stale result is dropped
 *   fail     release lease; retry with exponential backoff, FAILED after maxAttempts
 *
 * Crashed workers are handled by lease expiry: an expired PROCESSING job is
 * claimable again. Idle slots sleep for pollIntervalMs but are woken
 * immediately when the API queues work (EventBus), so latency stays low
 * without hammering the DB.
 */
export class AIWorkerService {
  constructor({
    repository,
    aiService,
    eventBus,
    logger = silentLogger,
    concurrency = 2,
    pollIntervalMs = 1000,
    leaseMs = 60_000,
    maxAttempts = 4,
    backoffBaseMs = 2000,
    workerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`,
  }) {
    Object.assign(this, { repository, aiService, eventBus, concurrency, pollIntervalMs, leaseMs, maxAttempts, backoffBaseMs, workerId });
    this.log = logger;
    this.running = false;
    this.loops = [];
    this.sleepers = new Set();
    this.stats = { claimed: 0, completed: 0, staleDiscarded: 0, retried: 0, failed: 0, vectorsReused: 0 };
    this.onQueued = () => this.wake();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.eventBus?.on('entry.queued', this.onQueued);
    this.loops = Array.from({ length: this.concurrency }, (_, slot) => this.#loop(slot));
    this.log.info(`started ${this.concurrency} slot(s)`, { workerId: this.workerId, ai: this.aiService.describe() });
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.eventBus?.off('entry.queued', this.onQueued);
    this.wake();
    await Promise.allSettled(this.loops);
    this.log.info('stopped', this.stats);
  }

  /**
   * Serverless mode: process ready jobs until the queue is empty or the time
   * budget runs out, then return. Same claim/commit protocol as the long-lived
   * loop, so any number of concurrent drains (across function instances) is
   * safe. Concurrent calls within one instance share a single drain.
   */
  drain({ budgetMs = 40_000, slots = this.concurrency } = {}) {
    if (this.draining) return this.draining;
    const deadline = Date.now() + budgetMs;
    const slot = async () => {
      let processed = 0;
      while (Date.now() < deadline) {
        const job = await this.repository.claimNext(this.workerId, this.leaseMs);
        if (!job) break;
        await this.processJob(job);
        processed += 1;
      }
      return processed;
    };
    this.draining = Promise.all(Array.from({ length: slots }, slot))
      .then((counts) => counts.reduce((a, b) => a + b, 0))
      .catch((err) => {
        this.log.error('drain failed', { error: err.message });
        return 0;
      })
      .finally(() => {
        this.draining = null;
      });
    return this.draining;
  }

  wake() {
    for (const resolve of this.sleepers) resolve();
    this.sleepers.clear();
  }

  #idle(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }

  async #loop(slot) {
    while (this.running) {
      let job = null;
      try {
        job = await this.repository.claimNext(this.workerId, this.leaseMs);
      } catch (err) {
        this.log.error(`slot ${slot}: claim failed`, { error: err.message });
      }
      if (!job) {
        await this.#idle(this.pollIntervalMs);
        continue;
      }
      await this.processJob(job);
    }
  }

  backoffFor(attempt) {
    const exp = this.backoffBaseMs * 2 ** (attempt - 1);
    return Math.min(exp, 5 * 60_000) + Math.floor(Math.random() * this.backoffBaseMs);
  }

  /** Public so tests can drive a single claimed job deterministically. */
  async processJob(job) {
    const id = String(job._id);
    const revision = job.coreRevision;
    const attempt = job.aiMetadata.attempts;
    this.stats.claimed += 1;
    this.eventBus?.changed(job, 'processing');
    const started = Date.now();

    let result;
    try {
      result = await this.aiService.enrich(job);
    } catch (err) {
      const terminal = attempt >= this.maxAttempts;
      const retryAt = terminal ? null : new Date(Date.now() + this.backoffFor(attempt));
      const released = await this.repository
        .recordFailure(id, this.workerId, revision, { error: err.message, retryAt, terminal })
        .catch((e) => this.log.error('recordFailure failed', { id, error: e.message }));
      if (released) this.stats[terminal ? 'failed' : 'retried'] += 1;
      this.log.warn(`${job.evidenceId} attempt ${attempt} failed${terminal ? ' (giving up)' : ''}`, {
        error: err.message,
        retryAt,
      });
      this.eventBus?.changed(job, terminal ? 'failed' : 'retry_scheduled');
      return { outcome: terminal ? 'failed' : 'retry' };
    }

    const committed = await this.repository.completeEnrichment(id, this.workerId, revision, result);
    if (!committed) {
      // Edited (revision bumped) or lease lost while the AI call ran. The
      // record is already PENDING for its newer revision - drop our result.
      this.stats.staleDiscarded += 1;
      this.log.info(`${job.evidenceId} r${revision}: result discarded (record changed mid-flight)`);
      return { outcome: 'stale' };
    }

    this.stats.completed += 1;
    if (result.vectorReused) this.stats.vectorsReused += 1;
    this.log.info(`${job.evidenceId} r${revision} -> ${result.riskLevel} (${result.riskScore})`, {
      ms: Date.now() - started,
      provider: result.provider,
      vectorReused: result.vectorReused,
    });
    this.eventBus?.changed(job, 'completed');
    return { outcome: 'completed', result };
  }
}
