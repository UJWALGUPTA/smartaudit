import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DeltaEvaluator, UPDATE_PATH } from '../src/services/DeltaEvaluator.js';
import { localEmbedding, cosine, VECTOR_DIMS } from '../src/services/ai/vector.js';
import { evaluateRules } from '../src/services/ai/RiskRules.js';
import { AIService } from '../src/services/ai/AIService.js';
import { MockAIProvider } from '../src/services/ai/providers/MockAIProvider.js';

const existing = {
  evidenceId: 'EVID-1',
  entityName: 'Global Procurement Services',
  eventType: 'Control Execution',
  description: 'Manual approval override executed for vendor invoice payables exceeding $50k threshold',
  monetaryImpact: 85000,
  controlId: 'CTRL-FIN-302',
  timestamp: '2026-07-21T10:00:00.000Z',
  aiMetadata: { auditorNotes: 'initial', status: 'COMPLETED' },
};

describe('DeltaEvaluator', () => {
  const delta = new DeltaEvaluator();

  test('notes-only edit is fast-tracked', () => {
    const r = delta.evaluate(existing, { aiMetadata: { auditorNotes: 'Reviewed with CFO' } });
    assert.equal(r.path, UPDATE_PATH.FAST_TRACK);
    assert.deepEqual(r.set, { 'aiMetadata.auditorNotes': 'Reviewed with CFO' });
  });

  test('top-level auditorNotes is accepted too', () => {
    assert.equal(delta.evaluate(existing, { auditorNotes: 'x' }).path, UPDATE_PATH.FAST_TRACK);
  });

  test('notesOnly() detects pure notes bodies for the read-free fast path', () => {
    assert.equal(delta.notesOnly({ auditorNotes: 'a' }), 'a');
    assert.equal(delta.notesOnly({ aiMetadata: { auditorNotes: '' } }), '');
    assert.equal(delta.notesOnly({ auditorNotes: 'a', monetaryImpact: 1 }), undefined);
    assert.equal(delta.notesOnly({ aiMetadata: { auditorNotes: 'a', riskScore: 1 } }), undefined);
    assert.throws(() => delta.notesOnly({ auditorNotes: 5 }), { status: 400 });
  });

  test('core field change requeues AI', () => {
    const r = delta.evaluate(existing, { monetaryImpact: 90000 });
    assert.equal(r.path, UPDATE_PATH.AI_REQUEUE);
    assert.deepEqual(r.coreChanged, ['monetaryImpact']);
  });

  test('core + notes in one request requeues and keeps the notes', () => {
    const r = delta.evaluate(existing, { controlId: 'CTRL-FIN-999', auditorNotes: 'moved control' });
    assert.equal(r.path, UPDATE_PATH.AI_REQUEUE);
    assert.equal(r.set['aiMetadata.auditorNotes'], 'moved control');
  });

  test('cosmetic differences are a no-op (no wasted AI call)', () => {
    const r = delta.evaluate(existing, {
      monetaryImpact: '85000',
      controlId: ' ctrl-fin-302 ',
      description: `  ${existing.description.replace(/ /g, '  ')} `,
      auditorNotes: 'initial',
    });
    assert.equal(r.path, UPDATE_PATH.NO_OP);
    assert.deepEqual(r.changedFields, []);
  });

  test('descriptive metadata updates directly without AI', () => {
    assert.equal(delta.evaluate(existing, { entityName: 'GPS Ltd' }).path, UPDATE_PATH.DIRECT_UPDATE);
  });

  test('AI-owned and immutable fields are rejected', () => {
    assert.throws(() => delta.evaluate(existing, { aiMetadata: { riskScore: 1 } }), { status: 422 });
    assert.throws(() => delta.evaluate(existing, { evidenceId: 'EVID-2' }), { status: 422 });
    assert.throws(() => delta.evaluate(existing, { foo: 1 }), { status: 400 });
    assert.throws(() => delta.evaluate(existing, { monetaryImpact: -5 }), { status: 400 });
  });
});

describe('local embedding', () => {
  test('is deterministic, 8-dim and unit length', () => {
    const a = localEmbedding(existing.description);
    assert.deepEqual(a, localEmbedding(existing.description));
    assert.equal(a.length, VECTOR_DIMS);
    assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-3);
  });

  test('semantically related exceptions are closer than unrelated ones', () => {
    const q = localEmbedding('Manual approval override on vendor invoice payable');
    const near = localEmbedding('Vendor invoice approval limit bypassed via manual override');
    const far = localEmbedding('Superuser access provisioned to contractor account');
    assert.ok(cosine(q, near) > cosine(q, far) + 0.3, `${cosine(q, near)} vs ${cosine(q, far)}`);
  });
});

describe('risk rules', () => {
  test('flags the spec example', () => {
    const r = evaluateRules(existing);
    assert.ok(r.flags.includes('MONETARY_THRESHOLD_EXCEEDED'));
    assert.ok(r.flags.includes('MANUAL_OVERRIDE'));
    assert.ok(['HIGH', 'CRITICAL'].includes(r.level));
  });

  test('routine expense is low risk', () => {
    const r = evaluateRules({ ...existing, description: 'Employee travel expense reimbursement within policy limits', monetaryImpact: 900, controlId: 'CTRL-OPS-1' });
    assert.equal(r.level, 'LOW');
  });
});

describe('AIService', () => {
  const mock = new MockAIProvider({ delayMs: 0 });

  test('falls back to the local engine when the LLM fails', async () => {
    const broken = { name: 'openai', model: 'x', assessRisk: async () => { throw new Error('429'); }, embed: async () => { throw new Error('429'); } };
    const svc = new AIService({ provider: broken, fallback: mock });
    const r = await svc.enrich(existing);
    assert.equal(r.provider, 'openai+fallback');
    assert.equal(r.semanticVector.length, 8);
  });

  test('sanitises model output and merges guardrail flags', async () => {
    const sloppy = {
      name: 'openai',
      model: 'x',
      assessRisk: async () => ({ riskScore: '142', aiSummary: '  Risky. ', anomalyFlags: ['unusual description pattern', 7] }),
      embed: async () => [3, 0, 0, 0, 0, 0, 0, 4],
    };
    const r = await new AIService({ provider: sloppy }).enrich(existing);
    assert.equal(r.riskScore, 100);
    assert.equal(r.riskLevel, 'CRITICAL');
    assert.equal(r.aiSummary, 'Risky.');
    assert.ok(r.anomalyFlags.includes('UNUSUAL_DESCRIPTION_PATTERN'));
    assert.ok(r.anomalyFlags.includes('MONETARY_THRESHOLD_EXCEEDED'), 'rule flag merged in');
    assert.deepEqual(r.semanticVector, [0.6, 0, 0, 0, 0, 0, 0, 0.8]);
  });

  test('rule-owned flags follow structured data, not the model', async () => {
    // Description still says ">$50k" but the amount was corrected to $4,500.
    const llm = {
      name: 'openai',
      model: 'x',
      assessRisk: async () => ({ riskScore: 70, aiSummary: 'x', anomalyFlags: ['MONETARY_THRESHOLD_EXCEEDED', 'MANUAL_OVERRIDE'] }),
      embed: async () => [1, 0, 0, 0, 0, 0, 0, 0],
    };
    const r = await new AIService({ provider: llm }).enrich({ ...existing, monetaryImpact: 4500 });
    assert.ok(!r.anomalyFlags.includes('MONETARY_THRESHOLD_EXCEEDED'));
    assert.ok(r.anomalyFlags.includes('MANUAL_OVERRIDE'), 'judgement flags from the model are kept');
  });

  test('rejects malformed model output so the worker retries', async () => {
    const bad = { name: 'openai', model: 'x', assessRisk: async () => ({ summary: 'no score' }), embed: mock.embed.bind(mock) };
    await assert.rejects(new AIService({ provider: bad }).enrich(existing), /riskScore/);
  });

  test('reuses the vector when the description did not change', async () => {
    let embeds = 0;
    const counting = { name: 'mock', model: 'm', assessRisk: mock.assessRisk.bind(mock), embed: async (t) => { embeds += 1; return mock.embed(t); } };
    const svc = new AIService({ provider: counting });
    const first = await svc.enrich(existing);
    const second = await svc.enrich({ ...existing, monetaryImpact: 1, aiMetadata: { ...first } });
    assert.equal(embeds, 1);
    assert.equal(second.vectorReused, true);
  });
});
