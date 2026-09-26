import mongoose from 'mongoose';
import { AuditRepository } from '../repositories/AuditRepository.js';
import { DeltaEvaluator, UPDATE_PATH } from '../services/DeltaEvaluator.js';
import { AI_STATUS } from '../models/AuditEntry.js';
import { badRequest, conflict, notFound, HttpError } from '../lib/errors.js';
import { silentLogger } from '../lib/logger.js';

const CREATE_FIELDS = ['timestamp', 'eventType', 'evidenceId', 'entityName', 'description', 'monetaryImpact', 'controlId', 'actorUserId'];
const MAX_UPDATE_RETRIES = 3;

export class AuditController {
  constructor({ repository, deltaEvaluator = new DeltaEvaluator(), eventBus, worker = null, logger = silentLogger }) {
    this.repository = repository;
    this.delta = deltaEvaluator;
    this.eventBus = eventBus;
    this.worker = worker;
    this.log = logger;
    // Bind so methods can be handed straight to the router.
    for (const name of ['list', 'get', 'create', 'update', 'similar', 'retry', 'events']) {
      this[name] = this[name].bind(this);
    }
  }

  #requireId(req) {
    const { id } = req.params;
    if (!AuditRepository.isValidId(id)) throw notFound();
    return id;
  }

  async list(req, res) {
    const [entries, counts] = await Promise.all([
      this.repository.list(req.tenantId),
      this.repository.statusCounts(req.tenantId),
    ]);
    res.json({ data: entries, meta: { counts } });
  }

  async get(req, res) {
    const entry = await this.repository.findById(req.tenantId, this.#requireId(req));
    if (!entry) throw notFound();
    res.json({ data: entry });
  }

  /** Scenario A: persist immediately as PENDING; enrichment happens async. */
  async create(req, res) {
    const body = req.body ?? {};
    const data = Object.fromEntries(CREATE_FIELDS.filter((f) => body[f] !== undefined).map((f) => [f, body[f]]));
    if (body.aiMetadata?.auditorNotes !== undefined || body.auditorNotes !== undefined) {
      data.aiMetadata = { auditorNotes: String(body.aiMetadata?.auditorNotes ?? body.auditorNotes) };
    }
    try {
      const entry = await this.repository.create(req.tenantId, data);
      this.eventBus.queued(entry);
      this.eventBus.changed(entry, 'created');
      res.status(202).location(`/api/audit-entries/${entry._id}`).json({ data: entry });
    } catch (err) {
      if (err instanceof mongoose.Error.ValidationError || err instanceof mongoose.Error.CastError) {
        const details = err.errors ? Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message])) : undefined;
        throw badRequest('Invalid audit entry', details);
      }
      if (err?.code === 11000) throw conflict(`evidenceId "${data.evidenceId}" already exists for this tenant`);
      throw err;
    }
  }

  /**
   * Scenario B: smart delta evaluation.
   *   notes only        -> FAST_TRACK: one atomic $set, AI queue untouched
   *   entity/eventType  -> DIRECT_UPDATE: $set, AI queue untouched
   *   core evidence     -> AI_REQUEUE: $set + coreRevision++ + status PENDING
   * Evidence writes use optimistic concurrency on coreRevision and retry on
   * conflict, so the delta is always computed against what is being replaced.
   */
  async update(req, res) {
    const id = this.#requireId(req);
    const started = process.hrtime.bigint();
    const elapsed = () => +(Number(process.hrtime.bigint() - started) / 1e6).toFixed(2);

    // Fast track: a notes-only body needs no delta against the stored record,
    // so skip the read - a single atomic $set is the whole request.
    const notes = this.delta.notesOnly(req.body);
    if (notes !== undefined) {
      const entry = await this.repository.setAuditorNotes(req.tenantId, id, notes);
      if (!entry) throw notFound();
      this.eventBus.changed(entry, 'fast_track');
      const durationMs = elapsed();
      this.log.info(`PUT ${entry.evidenceId} -> ${UPDATE_PATH.FAST_TRACK}`, { ms: durationMs });
      return res.json({
        data: entry,
        meta: { path: UPDATE_PATH.FAST_TRACK, changedFields: ['auditorNotes'], aiRecomputed: false, durationMs },
      });
    }

    for (let attempt = 1; attempt <= MAX_UPDATE_RETRIES; attempt += 1) {
      const existing = await this.repository.findById(req.tenantId, id);
      if (!existing) throw notFound();

      const delta = this.delta.evaluate(existing, req.body);
      let entry = existing;

      if (delta.path === UPDATE_PATH.FAST_TRACK) {
        entry = await this.repository.setAuditorNotes(req.tenantId, id, delta.set['aiMetadata.auditorNotes']);
        if (!entry) throw notFound();
      } else if (delta.path !== UPDATE_PATH.NO_OP) {
        const requeue = delta.path === UPDATE_PATH.AI_REQUEUE;
        entry = await this.repository.applyEvidenceUpdate(req.tenantId, id, existing.coreRevision, delta.set, { requeue });
        if (!entry) {
          this.log.info(`update conflict on ${existing.evidenceId}, retrying`, { attempt });
          continue;
        }
        if (requeue) this.eventBus.queued(entry);
      }

      if (delta.path !== UPDATE_PATH.NO_OP) this.eventBus.changed(entry, delta.path.toLowerCase());
      const durationMs = elapsed();
      this.log.info(`PUT ${entry.evidenceId} -> ${delta.path}`, { changed: delta.changedFields, ms: durationMs });
      return res.json({
        data: entry,
        meta: {
          path: delta.path,
          changedFields: delta.changedFields,
          aiRecomputed: delta.path === UPDATE_PATH.AI_REQUEUE,
          durationMs,
        },
      });
    }
    throw conflict('Entry is being modified concurrently; please retry');
  }

  /** Scenario C: top-3 most similar historical exceptions by semantic vector. */
  async similar(req, res) {
    const id = this.#requireId(req);
    const source = await this.repository.findById(req.tenantId, id);
    if (!source) throw notFound();
    const vector = source.aiMetadata?.semanticVector ?? [];
    if (source.aiMetadata?.status !== AI_STATUS.COMPLETED && vector.length === 0) {
      throw new HttpError(409, 'Semantic vector not ready yet - AI enrichment is still pending', {
        status: source.aiMetadata?.status,
      });
    }
    const k = Math.min(Math.max(Number.parseInt(req.query.k, 10) || 3, 1), 20);
    const started = Date.now();
    const results = await this.repository.findSimilar(req.tenantId, id, vector, k);
    res.json({
      data: results,
      meta: { sourceId: id, sourceEvidenceId: source.evidenceId, k, metric: 'cosine', tookMs: Date.now() - started },
    });
  }

  async retry(req, res) {
    const id = this.#requireId(req);
    const entry = await this.repository.requeue(req.tenantId, id);
    if (!entry) throw conflict('Only FAILED entries can be retried');
    this.eventBus.queued(entry);
    this.eventBus.changed(entry, 'requeued');
    res.status(202).json({ data: entry });
  }

  /** Server-Sent Events stream of entry changes for the caller's tenant. */
  events(req, res) {
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

    const tenant = String(req.tenantId);
    const onChange = (evt) => {
      if (evt.tenantId === tenant) res.write(`event: entry\ndata: ${JSON.stringify(evt)}\n\n`);
    };
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    this.eventBus.on('entry.changed', onChange);
    req.on('close', () => {
      clearInterval(heartbeat);
      this.eventBus.off('entry.changed', onChange);
    });
  }
}
