import crypto from 'node:crypto';

export const VECTOR_DIMS = 8;

const STOPWORDS = new Set(
  'a an and are as at be by for from has have in is it of on or that the this to was were with via per its into over under than'.split(' '),
);

/** Very light stemmer - enough to fold plurals/tenses together. */
export function stem(word) {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('es')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

/**
 * The 8 axes of the local embedding space. Each dimension is an audit-domain
 * concept, so the mock vectors are interpretable and similar exceptions land
 * near each other (unlike random vectors, which would make /similar useless).
 */
export const CONCEPT_AXES = [
  ['approval_override', 'override overrid manual bypass exception waive waiver approval approv circumvent force forced unauthoriz'],
  ['vendor_procurement', 'vendor supplier procurement purchase invoice po payable sourcing contract'],
  ['payment_cash', 'payment pay wire transfer cash disbursement refund cheque check ach bank remittance'],
  ['access_privilege', 'access privilege admin administrator role permission login credential superuser entitlement provision'],
  ['journal_reporting', 'journal ledger reconciliation posting adjustment accrual revenue reporting close recogni'],
  ['payroll_people', 'payroll salary employee bonus compensation contractor headcount expense reimbursement'],
  ['split_duplicate', 'duplicate split repeated multiple same fragment structur threshold below consecutive'],
  ['timing_anomaly', 'weekend after hour midnight late backdat urgent holiday night period end quarter'],
].map(([name, words]) => [name, new Set(words.split(' ').map(stem))]);

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function l2normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
  if (!norm) return vec.map(() => 0);
  return vec.map((x) => x / norm);
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const round = (x, dp = 4) => Math.round(x * 10 ** dp) / 10 ** dp;

/**
 * Deterministic 8-dim semantic embedding: concept-lexicon hits (strong signal)
 * plus a small hashed residual so text with no lexicon hits still gets a
 * stable, non-zero vector. Output is L2-normalised.
 */
export function localEmbedding(text) {
  const vec = new Array(VECTOR_DIMS).fill(0);
  for (const token of tokenize(text)) {
    let hit = false;
    CONCEPT_AXES.forEach(([, lexicon], dim) => {
      if (lexicon.has(token)) {
        vec[dim] += 1;
        hit = true;
      }
    });
    if (!hit) vec[fnv1a(token) % VECTOR_DIMS] += 0.15;
  }
  return l2normalize(vec).map((x) => round(x));
}

/** Coerce any provider output into a clean unit-length VECTOR_DIMS array. */
export function sanitizeVector(raw) {
  if (!Array.isArray(raw) || raw.length !== VECTOR_DIMS || raw.some((x) => !Number.isFinite(x))) {
    throw new Error(`invalid embedding: expected ${VECTOR_DIMS} finite numbers`);
  }
  return l2normalize(raw).map((x) => round(x));
}

export function vectorSourceHash(text) {
  return crypto.createHash('sha256').update(String(text ?? '').trim().toLowerCase()).digest('hex').slice(0, 16);
}
