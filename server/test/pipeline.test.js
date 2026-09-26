/**
 * Integration tests against a real (ephemeral, in-memory) mongod. These cover
 * the concurrency guarantees: exclusive claims, stale-result rejection,
 * fast-track writes surviving enrichment, lease recovery, retry/backoff, and
 * the HTTP delta paths.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import { AuditEntry } from '../src/models/AuditEntry.js';
import { AuditRepository } from '../src/repositories/AuditRepository.js';
import { AIService } from '../src/services/ai/AIService.js';
import { MockAIProvider } from '../src/services/ai/providers/MockAIProvider.js';
import { AIWorkerService } from '../src/services/AIWorkerService.js';
import { AuditController } from '../src/controllers/AuditController.js';
import { EventBus } from '../src/lib/EventBus.js';
import { createApp } from '../src/app.js';

const TENANT = '66a0c0ffee00000000000001';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mongod;
let repo;
let seq = 0;
const aiService = new AIService({ provider: new MockAIProvider({ delayMs: 0 }) });

const sample = (overrides = {}) => ({
  eventType: 'Control Execution',
  evidenceId: `EVID-T${(seq += 1)}`,
  entityName: 'Global Procurement Services',
  description: 'Manual approval override executed for vendor invoice payables exceeding $50k threshold',
  monetaryImpact: 85000,
  controlId: 'CTRL-FIN-302',
  actorUserId: 'user_7731',
  timestamp: new Date('2026-07-21T10:00:00Z'),
  ...overrides,
});

const makeWorker = (opts = {}) =>
  new AIWorkerService({ repository: repo, aiService, workerId: 'w-test', backoffBaseMs: 0, ...opts });

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await AuditEntry.syncIndexes();
  repo = new AuditRepository();
});

after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await AuditEntry.deleteMany({});
});

describe('queue semantics', () => {
  test('new entries are persisted as PENDING', async () => {
    const e = await repo.create(TENANT, sample());
    assert.equal(e.aiMetadata.status, 'PENDING');
    assert.equal(e.aiMetadata.riskScore, null);
    assert.equal(e.coreRevision, 1);
  });

  test('concurrent workers can never claim the same job', async () => {
    await repo.create(TENANT, sample());
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => repo.claimNext(`w${i}`, 60_000)));
    assert.equal(claims.filter(Boolean).length, 1);
  });

  test('core edit during enrichment: stale result is discarded, new revision is enriched', async () => {
    const e = await repo.create(TENANT, sample({ monetaryImpact: 85000 }));
    const job = await repo.claimNext('w1', 60_000);
    const result = await aiService.enrich(job); // "LLM call in flight"...

    // ...meanwhile the auditor corrects the amount
    const edited = await repo.applyEvidenceUpdate(TENANT, e._id, 1, { monetaryImpact: 500 }, { requeue: true });
    assert.equal(edited.coreRevision, 2);
    assert.equal(edited.aiMetadata.status, 'PENDING');

    assert.equal(await repo.completeEnrichment(e._id, 'w1', job.coreRevision, result), false);
    const afterStale = await repo.findById(TENANT, e._id);
    assert.equal(afterStale.aiMetadata.status, 'PENDING', 'stale commit must not mark COMPLETED');
    assert.equal(afterStale.aiMetadata.riskScore, null);

    const out = await makeWorker().processJob(await repo.claimNext('w-test', 60_000));
    assert.equal(out.outcome, 'completed');
    const final = await repo.findById(TENANT, e._id);
    assert.equal(final.aiMetadata.enrichedRevision, 2);
    assert.equal(final.monetaryImpact, 500);
    assert.ok(!final.aiMetadata.anomalyFlags.includes('MONETARY_THRESHOLD_EXCEEDED'));
  });

  test('fast-track note written mid-enrichment survives the AI commit', async () => {
    const e = await repo.create(TENANT, sample());
    const job = await repo.claimNext('w1', 60_000);
    await repo.setAuditorNotes(TENANT, e._id, 'Escalated to controller');
    assert.equal(await repo.completeEnrichment(e._id, 'w1', job.coreRevision, await aiService.enrich(job)), true);

    const final = await repo.findById(TENANT, e._id);
    assert.equal(final.aiMetadata.status, 'COMPLETED');
    assert.equal(final.aiMetadata.auditorNotes, 'Escalated to controller');
    assert.equal(final.description, sample().description, 'baseline evidence untouched');
  });

  test('expired lease is reclaimed and the original worker can no longer commit', async () => {
    const e = await repo.create(TENANT, sample());
    const job = await repo.claimNext('crashed', 1);
    await sleep(10);
    const reclaimed = await repo.claimNext('rescuer', 60_000);
    assert.equal(String(reclaimed._id), String(e._id));
    assert.equal(reclaimed.aiMetadata.attempts, 2);
    assert.equal(await repo.completeEnrichment(e._id, 'crashed', job.coreRevision, await aiService.enrich(job)), false);
  });

  test('failures back off and become FAILED after maxAttempts', async () => {
    const flaky = new AIService({ provider: { name: 'x', model: 'x', assessRisk: async () => { throw new Error('boom'); }, embed: async () => [1, 0, 0, 0, 0, 0, 0, 0] } });
    const worker = makeWorker({ aiService: flaky, maxAttempts: 2 });
    const e = await repo.create(TENANT, sample());

    assert.equal((await worker.processJob(await repo.claimNext('w-test', 60_000))).outcome, 'retry');
    let doc = await repo.findById(TENANT, e._id);
    assert.equal(doc.aiMetadata.status, 'PENDING');
    assert.equal(doc.aiMetadata.lastError, 'boom');

    await sleep(5);
    assert.equal((await worker.processJob(await repo.claimNext('w-test', 60_000))).outcome, 'failed');
    doc = await repo.findById(TENANT, e._id);
    assert.equal(doc.aiMetadata.status, 'FAILED');
    assert.equal(await repo.claimNext('w-test', 60_000), null, 'FAILED jobs are not re-claimed');
  });

  test('serverless drain(): concurrent drains process every job exactly once', async () => {
    await Promise.all([1, 2, 3, 4, 5, 6].map(() => repo.create(TENANT, sample())));
    // Two "function instances" draining the same queue at once.
    const a = makeWorker({ workerId: 'fn-a', concurrency: 2 });
    const b = makeWorker({ workerId: 'fn-b', concurrency: 2 });
    const [na, nb] = await Promise.all([a.drain({ budgetMs: 10_000 }), b.drain({ budgetMs: 10_000 })]);
    assert.equal(na + nb, 6);
    assert.equal((await repo.statusCounts(TENANT)).COMPLETED, 6);
    assert.equal(await a.drain(), 0, 'empty queue drains to 0');
  });

  test('running worker drains the queue', async () => {
    const worker = makeWorker({ concurrency: 3, pollIntervalMs: 20 });
    await Promise.all([1, 2, 3, 4, 5].map(() => repo.create(TENANT, sample())));
    worker.start();
    for (let i = 0; i < 100 && (await repo.statusCounts(TENANT)).COMPLETED < 5; i += 1) await sleep(20);
    await worker.stop();
    assert.equal((await repo.statusCounts(TENANT)).COMPLETED, 5);
  });
});

describe('HTTP API', () => {
  let server;
  let base;
  let worker;

  before(async () => {
    const eventBus = new EventBus();
    worker = makeWorker({ eventBus, pollIntervalMs: 20 });
    const controller = new AuditController({ repository: repo, eventBus, worker });
    const app = createApp({ controller, worker, aiService, defaultTenantId: TENANT });
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}/api/audit-entries`;
    worker.start();
  });

  after(async () => {
    await worker.stop();
    server.close();
  });

  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  const waitForStatus = async (id, status) => {
    for (let i = 0; i < 100; i += 1) {
      const { body } = await call('GET', `/${id}`);
      if (body.data.aiMetadata.status === status) return body.data;
      await sleep(20);
    }
    throw new Error(`timed out waiting for ${status}`);
  };

  test('POST -> PENDING -> COMPLETED; PUT paths behave per delta', async () => {
    const created = await call('POST', '', sample());
    assert.equal(created.status, 202);
    assert.equal(created.body.data.aiMetadata.status, 'PENDING');
    const id = created.body.data._id;

    const done = await waitForStatus(id, 'COMPLETED');
    assert.equal(done.aiMetadata.semanticVector.length, 8);
    assert.ok(done.aiMetadata.aiSummary);

    const notes = await call('PUT', `/${id}`, { aiMetadata: { auditorNotes: 'Looks fine' } });
    assert.equal(notes.body.meta.path, 'FAST_TRACK');
    assert.equal(notes.body.meta.aiRecomputed, false);
    assert.equal(notes.body.data.aiMetadata.status, 'COMPLETED');
    assert.equal(notes.body.data.aiMetadata.enrichedAt, done.aiMetadata.enrichedAt, 'AI output untouched');

    const same = await call('PUT', `/${id}`, { monetaryImpact: 85000 });
    assert.equal(same.body.meta.path, 'NO_OP');

    const core = await call('PUT', `/${id}`, { description: 'Duplicate vendor payment released twice' });
    assert.equal(core.body.meta.path, 'AI_REQUEUE');
    assert.equal(core.body.data.aiMetadata.status, 'PENDING');
    const redone = await waitForStatus(id, 'COMPLETED');
    assert.equal(redone.aiMetadata.enrichedRevision, 2);
    assert.equal(redone.aiMetadata.auditorNotes, 'Looks fine');

    assert.equal((await call('PUT', `/${id}`, { aiMetadata: { riskScore: 0 } })).status, 422);
    assert.equal((await call('POST', '', { ...sample(), evidenceId: done.evidenceId })).status, 409);
    assert.equal((await call('POST', '', { evidenceId: 'X' })).status, 400);
  });

  test('similar returns top 3 by cosine, excluding self', async () => {
    const descs = [
      'Manual approval override on vendor invoice payable',
      'Vendor invoice approval limit bypassed via manual override',
      'Procurement lead forced approval of supplier invoice',
      'Superuser access provisioned to contractor account',
      'Employee payroll bonus disbursement',
    ];
    const ids = [];
    for (const description of descs) ids.push((await call('POST', '', sample({ description }))).body.data._id);
    for (const id of ids) await waitForStatus(id, 'COMPLETED');

    const { status, body } = await call('POST', `/${ids[0]}/similar`);
    assert.equal(status, 200);
    assert.equal(body.data.length, 3);
    assert.ok(!body.data.some((d) => d._id === ids[0]));
    const sims = body.data.map((d) => d.similarity);
    assert.deepEqual(sims, [...sims].sort((a, b) => b - a));
    const topTwo = new Set(body.data.slice(0, 2).map((d) => d._id));
    assert.deepEqual(topTwo, new Set([ids[1], ids[2]]), 'the other procurement-override exceptions rank first');
    assert.ok(sims[1] > 0.9 && sims[2] < 0.5, `clear separation from unrelated records: ${sims}`);
  });
});
