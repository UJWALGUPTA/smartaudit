import { badRequest, unprocessable } from '../lib/errors.js';

export const UPDATE_PATH = Object.freeze({
  NO_OP: 'NO_OP',
  FAST_TRACK: 'FAST_TRACK', // auditorNotes only -> atomic $set, AI untouched
  DIRECT_UPDATE: 'DIRECT_UPDATE', // descriptive metadata -> $set, AI untouched
  AI_REQUEUE: 'AI_REQUEUE', // core financial evidence -> $set + back to PENDING
});

const normaliseText = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

/**
 * Field policy. Only fields the AI actually reads (and whose change could
 * alter its verdict) trigger recomputation. Each field declares how to
 * normalise input, so cosmetic edits (whitespace, "ctrl-fin-302" vs
 * "CTRL-FIN-302", "85000" vs 85000) are recognised as no change.
 */
const CORE_FIELDS = {
  monetaryImpact: (v) => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw badRequest('monetaryImpact must be a non-negative number');
    return Math.round(n * 100) / 100;
  },
  description: (v) => {
    const s = normaliseText(v);
    if (!s) throw badRequest('description cannot be empty');
    return s;
  },
  controlId: (v) => {
    const s = normaliseText(v).toUpperCase();
    if (!s) throw badRequest('controlId cannot be empty');
    return s;
  },
};

const METADATA_FIELDS = {
  entityName: (v) => {
    const s = normaliseText(v);
    if (!s) throw badRequest('entityName cannot be empty');
    return s;
  },
  eventType: (v) => {
    const s = normaliseText(v);
    if (!s) throw badRequest('eventType cannot be empty');
    return s;
  },
};

const IMMUTABLE_FIELDS = new Set(['_id', 'evidenceId', 'tenantId', 'timestamp', 'actorUserId', 'created', 'updated', 'coreRevision']);
const MAX_NOTES_LENGTH = 5000;

export class DeltaEvaluator {
  static CORE_FIELDS = Object.keys(CORE_FIELDS);

  /** Pull auditorNotes from either `{auditorNotes}` or `{aiMetadata:{auditorNotes}}`. */
  static #extractNotes(patch) {
    const { aiMetadata, ...rest } = patch;
    let notes;
    if (aiMetadata !== undefined) {
      if (aiMetadata === null || typeof aiMetadata !== 'object' || Array.isArray(aiMetadata)) {
        throw badRequest('aiMetadata must be an object');
      }
      const aiOwned = Object.keys(aiMetadata).filter((k) => k !== 'auditorNotes');
      if (aiOwned.length) {
        throw unprocessable(`aiMetadata.${aiOwned[0]} is computed by the AI engine and cannot be written`, { fields: aiOwned });
      }
      notes = aiMetadata.auditorNotes;
    }
    if (rest.auditorNotes !== undefined) notes = rest.auditorNotes;
    delete rest.auditorNotes;
    return { notes, fields: rest };
  }

  static #validateNotes(notes) {
    if (typeof notes !== 'string') throw badRequest('auditorNotes must be a string');
    if (notes.length > MAX_NOTES_LENGTH) throw badRequest(`auditorNotes exceeds ${MAX_NOTES_LENGTH} characters`);
    return notes;
  }

  /**
   * If the body touches nothing but auditorNotes, return the validated notes
   * so the caller can skip reading the record entirely (one atomic $set, one
   * round trip). Returns undefined for any other body.
   */
  notesOnly(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return undefined;
    const keys = Object.keys(patch);
    const nested = patch.aiMetadata;
    if (keys.length === 1 && keys[0] === 'auditorNotes') return DeltaEvaluator.#validateNotes(patch.auditorNotes);
    if (
      keys.length === 1 && keys[0] === 'aiMetadata' && nested && typeof nested === 'object' &&
      Object.keys(nested).length === 1 && 'auditorNotes' in nested
    ) {
      return DeltaEvaluator.#validateNotes(nested.auditorNotes);
    }
    return undefined;
  }

  /**
   * Classify a PUT body against the stored record.
   * @returns {{path, changedFields, set, coreChanged}}  `set` holds $set paths.
   */
  evaluate(existing, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest('Body must be a JSON object');

    const { notes, fields } = DeltaEvaluator.#extractNotes(patch);
    const immutable = Object.keys(fields).filter((k) => IMMUTABLE_FIELDS.has(k));
    if (immutable.length) throw unprocessable(`${immutable.join(', ')} cannot be modified`, { fields: immutable });
    const unknown = Object.keys(fields).filter((k) => !(k in CORE_FIELDS) && !(k in METADATA_FIELDS));
    if (unknown.length) throw badRequest(`Unknown field(s): ${unknown.join(', ')}`, { fields: unknown });

    const set = {};
    const changed = { core: [], metadata: [], notes: false };

    for (const [field, normalise] of Object.entries({ ...CORE_FIELDS, ...METADATA_FIELDS })) {
      if (fields[field] === undefined) continue;
      const next = normalise(fields[field]);
      if (next === normalise(existing[field])) continue;
      set[field] = next;
      (field in CORE_FIELDS ? changed.core : changed.metadata).push(field);
    }

    if (notes !== undefined) {
      DeltaEvaluator.#validateNotes(notes);
      if (notes !== (existing.aiMetadata?.auditorNotes ?? '')) {
        set['aiMetadata.auditorNotes'] = notes;
        changed.notes = true;
      }
    }

    const changedFields = [...changed.core, ...changed.metadata, ...(changed.notes ? ['auditorNotes'] : [])];
    let path = UPDATE_PATH.NO_OP;
    if (changed.core.length) path = UPDATE_PATH.AI_REQUEUE;
    else if (changed.metadata.length) path = UPDATE_PATH.DIRECT_UPDATE;
    else if (changed.notes) path = UPDATE_PATH.FAST_TRACK;

    return { path, changedFields, set, coreChanged: changed.core };
  }
}
