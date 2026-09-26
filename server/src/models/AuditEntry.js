import mongoose from 'mongoose';

const { Schema } = mongoose;

export const AI_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

export const RISK_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

/**
 * Evidence fields are written by ingestion/auditors; everything under
 * aiMetadata except `auditorNotes` is owned by the AI worker. Keeping the two
 * apart (and only ever writing with targeted $set paths) means neither side
 * can clobber the other.
 */
const aiMetadataSchema = new Schema(
  {
    status: { type: String, enum: Object.values(AI_STATUS), default: AI_STATUS.PENDING },
    riskScore: { type: Number, default: null },
    riskLevel: { type: String, enum: [...RISK_LEVELS, null], default: null },
    aiSummary: { type: String, default: null },
    anomalyFlags: { type: [String], default: [] },
    semanticVector: { type: [Number], default: [] },
    auditorNotes: { type: String, default: '' },

    // Enrichment provenance
    provider: { type: String, default: null },
    model: { type: String, default: null },
    enrichedAt: { type: Date, default: null },
    enrichedRevision: { type: Number, default: null },
    vectorSourceHash: { type: String, default: null },

    // Queue bookkeeping (MongoDB is the queue)
    queuedAt: { type: Date, default: Date.now },
    nextAttemptAt: { type: Date, default: Date.now },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    lockedBy: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
  },
  { _id: false },
);

const auditEntrySchema = new Schema(
  {
    timestamp: { type: Date, required: true, default: Date.now },
    eventType: { type: String, required: true, trim: true },
    evidenceId: { type: String, required: true, trim: true },
    entityName: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    monetaryImpact: { type: Number, required: true, min: 0 },
    controlId: { type: String, required: true, trim: true, uppercase: true },
    actorUserId: { type: String, required: true, trim: true },
    tenantId: { type: Schema.Types.ObjectId, required: true },

    // Bumped on every core-field change. The worker only commits results for
    // the revision it read, so edits made mid-enrichment are never lost.
    coreRevision: { type: Number, default: 1 },

    aiMetadata: { type: aiMetadataSchema, default: () => ({}) },
  },
  {
    timestamps: { createdAt: 'created', updatedAt: 'updated' },
    versionKey: false,
  },
);

// Idempotent ingestion: one evidence record per tenant.
auditEntrySchema.index({ tenantId: 1, evidenceId: 1 }, { unique: true });
// Dashboard listing.
auditEntrySchema.index({ tenantId: 1, created: -1 });
// Worker claim queries (ready PENDING jobs, expired PROCESSING leases).
auditEntrySchema.index({ 'aiMetadata.status': 1, 'aiMetadata.nextAttemptAt': 1 });
auditEntrySchema.index({ 'aiMetadata.status': 1, 'aiMetadata.lockedUntil': 1 });
// Similarity candidate scan.
auditEntrySchema.index({ tenantId: 1, 'aiMetadata.status': 1 });

export const AuditEntry = mongoose.models.AuditEntry || mongoose.model('AuditEntry', auditEntrySchema);
