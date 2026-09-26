import mongoose from 'mongoose';
import { AuditEntry, AI_STATUS } from '../models/AuditEntry.js';

const { ObjectId } = mongoose.Types;
const toObjectId = (id) => (id instanceof ObjectId ? id : new ObjectId(String(id)));
const AFTER = { returnDocument: 'after', lean: true };

/** Fields that reset an entry back onto the AI queue. */
function requeueFields(now) {
  return {
    'aiMetadata.status': AI_STATUS.PENDING,
    'aiMetadata.queuedAt': now,
    'aiMetadata.nextAttemptAt': now,
    'aiMetadata.attempts': 0,
    'aiMetadata.lastError': null,
    'aiMetadata.lockedBy': null,
    'aiMetadata.lockedUntil': null,
  };
}

/**
 * The only class that talks to MongoDB. Every write is a single atomic
 * operation with targeted `$set` paths, and every write that could race is
 * guarded by a precondition in its filter (revision / lease owner).
 */
export class AuditRepository {
  constructor(model = AuditEntry) {
    this.model = model;
  }

  static isValidId(id) {
    return mongoose.isValidObjectId(id) && String(new ObjectId(String(id))) === String(id);
  }

  // --------------------------------------------------------------- reads

  async findById(tenantId, id) {
    return this.model.findOne({ _id: toObjectId(id), tenantId: toObjectId(tenantId) }).lean();
  }

  async list(tenantId, { limit = 200 } = {}) {
    return this.model
      .find({ tenantId: toObjectId(tenantId) })
      .sort({ created: -1 })
      .limit(limit)
      .lean();
  }

  async statusCounts(tenantId) {
    const rows = await this.model.aggregate([
      { $match: { tenantId: toObjectId(tenantId) } },
      { $group: { _id: '$aiMetadata.status', count: { $sum: 1 } } },
    ]);
    const counts = Object.fromEntries(Object.values(AI_STATUS).map((s) => [s, 0]));
    for (const row of rows) counts[row._id] = row.count;
    return counts;
  }

  // -------------------------------------------------------------- writes

  async create(tenantId, data) {
    const doc = await this.model.create({ ...data, tenantId: toObjectId(tenantId) });
    return doc.toObject();
  }

  /** Fast track: one atomic $set on a field the AI worker never writes. */
  async setAuditorNotes(tenantId, id, auditorNotes) {
    return this.model.findOneAndUpdate(
      { _id: toObjectId(id), tenantId: toObjectId(tenantId) },
      { $set: { 'aiMetadata.auditorNotes': auditorNotes } },
      AFTER,
    );
  }

  /**
   * Optimistic-concurrency update of evidence fields. Returns null when the
   * record's coreRevision moved since the caller read it (caller retries).
   * With `requeue`, the revision is bumped and the entry goes back to PENDING,
   * which also invalidates any in-flight enrichment of the old revision.
   */
  async applyEvidenceUpdate(tenantId, id, expectedRevision, set, { requeue }) {
    const update = { $set: { ...set } };
    if (requeue) {
      Object.assign(update.$set, requeueFields(new Date()));
      update.$inc = { coreRevision: 1 };
    }
    return this.model.findOneAndUpdate(
      { _id: toObjectId(id), tenantId: toObjectId(tenantId), coreRevision: expectedRevision },
      update,
      AFTER,
    );
  }

  async deleteAllForTenant(tenantId) {
    return this.model.deleteMany({ tenantId: toObjectId(tenantId) });
  }

  // --------------------------------------------------------------- queue

  /**
   * Atomically claim the oldest ready job. A job is ready when it is PENDING
   * and its backoff has elapsed, or when it is PROCESSING but the previous
   * worker's lease expired (crash recovery). findOneAndUpdate guarantees two
   * workers can never claim the same document.
   */
  async claimNext(workerId, leaseMs) {
    const now = new Date();
    return this.model.findOneAndUpdate(
      {
        $or: [
          { 'aiMetadata.status': AI_STATUS.PENDING, 'aiMetadata.nextAttemptAt': { $lte: now } },
          { 'aiMetadata.status': AI_STATUS.PROCESSING, 'aiMetadata.lockedUntil': { $lt: now } },
        ],
      },
      {
        $set: {
          'aiMetadata.status': AI_STATUS.PROCESSING,
          'aiMetadata.lockedBy': workerId,
          'aiMetadata.lockedUntil': new Date(now.getTime() + leaseMs),
        },
        $inc: { 'aiMetadata.attempts': 1 },
      },
      { ...AFTER, sort: { 'aiMetadata.nextAttemptAt': 1 } },
    );
  }

  /** Precondition shared by commit/fail: still ours, still the same revision. */
  static #ownedJobFilter(id, workerId, revision) {
    return {
      _id: toObjectId(id),
      coreRevision: revision,
      'aiMetadata.status': AI_STATUS.PROCESSING,
      'aiMetadata.lockedBy': workerId,
    };
  }

  /**
   * Commit AI output. Writes only AI-owned paths (never auditorNotes or
   * evidence). Returns false if the result is stale - the record was edited
   * or re-leased while the AI call was running - in which case nothing is
   * written and the newer PENDING job will produce fresh results.
   */
  async completeEnrichment(id, workerId, revision, result) {
    const res = await this.model.updateOne(AuditRepository.#ownedJobFilter(id, workerId, revision), {
      $set: {
        'aiMetadata.status': AI_STATUS.COMPLETED,
        'aiMetadata.riskScore': result.riskScore,
        'aiMetadata.riskLevel': result.riskLevel,
        'aiMetadata.aiSummary': result.aiSummary,
        'aiMetadata.anomalyFlags': result.anomalyFlags,
        'aiMetadata.semanticVector': result.semanticVector,
        'aiMetadata.vectorSourceHash': result.vectorSourceHash,
        'aiMetadata.provider': result.provider,
        'aiMetadata.model': result.model,
        'aiMetadata.enrichedAt': new Date(),
        'aiMetadata.enrichedRevision': revision,
        'aiMetadata.lastError': null,
        'aiMetadata.lockedBy': null,
        'aiMetadata.lockedUntil': null,
      },
    });
    return res.modifiedCount === 1;
  }

  /** Release the lease after a failed attempt: retry later, or give up. */
  async recordFailure(id, workerId, revision, { error, retryAt, terminal }) {
    const res = await this.model.updateOne(AuditRepository.#ownedJobFilter(id, workerId, revision), {
      $set: {
        'aiMetadata.status': terminal ? AI_STATUS.FAILED : AI_STATUS.PENDING,
        'aiMetadata.nextAttemptAt': retryAt ?? new Date(),
        'aiMetadata.lastError': String(error).slice(0, 500),
        'aiMetadata.lockedBy': null,
        'aiMetadata.lockedUntil': null,
      },
    });
    return res.modifiedCount === 1;
  }

  /** Manual retry of a FAILED record. */
  async requeue(tenantId, id) {
    return this.model.findOneAndUpdate(
      { _id: toObjectId(id), tenantId: toObjectId(tenantId), 'aiMetadata.status': AI_STATUS.FAILED },
      { $set: requeueFields(new Date()) },
      AFTER,
    );
  }

  // ---------------------------------------------------------- similarity

  /**
   * Top-k cosine similarity computed inside MongoDB. Vectors are stored
   * L2-normalised, so cosine == dot product, which $reduce evaluates per
   * candidate; only k documents ever leave the database. With Atlas this
   * pipeline is swapped for a $vectorSearch (HNSW) stage - see README.
   */
  async findSimilar(tenantId, excludeId, queryVector, k = 3) {
    const dims = queryVector.length;
    return this.model.aggregate([
      {
        $match: {
          tenantId: toObjectId(tenantId),
          _id: { $ne: toObjectId(excludeId) },
          'aiMetadata.status': AI_STATUS.COMPLETED,
          'aiMetadata.semanticVector': { $size: dims },
        },
      },
      {
        $addFields: {
          similarity: {
            $reduce: {
              input: { $range: [0, dims] },
              initialValue: 0,
              in: {
                $add: [
                  '$$value',
                  {
                    $multiply: [
                      { $arrayElemAt: ['$aiMetadata.semanticVector', '$$this'] },
                      { $arrayElemAt: [{ $literal: queryVector }, '$$this'] },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
      { $sort: { similarity: -1, created: -1 } },
      { $limit: k },
      {
        $project: {
          evidenceId: 1,
          timestamp: 1,
          eventType: 1,
          entityName: 1,
          description: 1,
          monetaryImpact: 1,
          controlId: 1,
          similarity: 1,
          'aiMetadata.riskScore': 1,
          'aiMetadata.riskLevel': 1,
          'aiMetadata.anomalyFlags': 1,
          'aiMetadata.aiSummary': 1,
        },
      },
    ]);
  }
}
