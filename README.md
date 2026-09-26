# SmartAudit — AI-Enriched Continuous Audit Pipeline

A prototype audit SaaS backend + dashboard (MongoDB, Express, React, Node). It ingests raw audit evidence, enriches it asynchronously with AI risk scores, summaries, anomaly flags and 8-dim semantic vectors, and routes each update either to a fast path or back through the AI queue, depending on which fields changed.

## Quick start

```bash
cp .env.example .env
npm install
npm run dev      # API :4000 + dashboard http://localhost:5173
npm run seed     # in a 2nd terminal: 5 sample entries (add -- --extended for 12)
npm test         # 27 unit + integration tests (real mongod, in-memory)
```

**You don't need to install MongoDB.** If `MONGO_URI` is empty, the app starts an embedded `mongod` on port 27018 and stores its data in `./.data/db`. `npm run seed` and `npm run dev` share that instance. To use your own server, set `MONGO_URI` (or run `docker compose up -d` and point `MONGO_URI` at it).

**AI engine:** `MOCK_AI=true` (the default) uses the local simulation engine, which has a 400 ms delay and gives deterministic results. To use a live LLM, set `MOCK_AI=false` and `OPENAI_API_KEY=...`. `OPENAI_BASE_URL` accepts any OpenAI-compatible endpoint, such as Groq.

`npm start` builds the client and serves it from the API on :4000.

## API

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/api/audit-entries` | Validates the entry, saves it as `PENDING` and returns **202**. The worker enriches it asynchronously. Posting the same `evidenceId` twice for a tenant returns **409**. |
| `PUT` | `/api/audit-entries/:id` | Runs the smart delta evaluation (below). The response includes `meta.path`, `changedFields`, `aiRecomputed` and `durationMs`. |
| `POST` | `/api/audit-entries/:id/similar` | Returns the top 3 most similar enriched exceptions by cosine similarity (`?k=` up to 20). |
| `POST` | `/api/audit-entries/:id/retry` | Re-queues a `FAILED` entry. |
| `GET` | `/api/audit-entries[/:id]` | Lists entries (with status counts) or returns one entry. |
| `GET` | `/api/audit-entries/events` | Server-Sent Events stream of entry changes for the tenant. |
| `GET` | `/api/health` | Reports DB state, runtime, AI provider and worker stats. |
| `POST` | `/api/worker/drain` | Processes ready jobs within a time budget (how work runs on serverless). |

Each request is scoped to a tenant through the `x-tenant-id` header. Without the header it falls back to `DEFAULT_TENANT_ID`, which stands in for a claim from an auth token.

## Architecture

```
            POST / PUT
                │
        AuditController ── DeltaEvaluator ──► FAST_TRACK / DIRECT_UPDATE: one atomic $set, done
                │                         └─► AI_REQUEUE: $set + coreRevision++ + status=PENDING
                ▼
         AuditRepository  ◄──────────── the only class that touches MongoDB
                ▲
   claim (findOneAndUpdate PENDING→PROCESSING + lease)
                │
         AIWorkerService (N slots) ──► AIService ──► OpenAIProvider | MockAIProvider
                │                         (rate limit, fallback, output validation, guardrail flags)
   commit (updateOne guarded by coreRevision + lockedBy)
                │
            EventBus ──► SSE ──► AuditDashboard (React class components)
```

`server/src`:
- `controllers/AuditController.js`: the HTTP layer and the update orchestration.
- `services/DeltaEvaluator.js`: the field policy.
- `services/AIWorkerService.js`: the queue loop.
- `services/ai/`: `AIService`, the providers, `RiskRules`, `RateLimiter` and the vector math.
- `repositories/AuditRepository.js`: every query.

`client/src/components`: `AuditDashboard` and its children, all written as `React.Component` classes.

## Design decisions (technical review topics)

### 1. AI workload integration
- **Provider abstraction.** `AIService` depends on a small `assessRisk()` / `embed()` interface. `OpenAIProvider` and `MockAIProvider` both implement it, so switching between them is a config change.
- **Rate limiting.** A token bucket shared by all worker slots means worker concurrency can never exceed the provider's RPM budget. Requests over the budget wait in a queue instead of failing.
- **Retries.** Inside the provider, 429, 5xx and timeout errors are retried with exponential backoff plus jitter, and `Retry-After` is honoured. Other 4xx errors fail immediately. Each call has a timeout (`AbortSignal.timeout`).
- **Fallback.** If the LLM still fails, `AIService` falls back to the local engine and records `provider: "openai+fallback"`, so it's visible which records were degraded. If fallback is disabled, the worker's own retry and backoff take over, and after `WORKER_MAX_ATTEMPTS` the entry becomes `FAILED` and can be retried manually.
- **Output validation.** Model output is never trusted. The score is coerced and clamped, the risk level is derived from the score (so it's never taken from the model directly), the summary is required and length-capped, flags are normalised, and vectors are checked for the right dimension and L2-normalised. If output is malformed, the attempt throws and gets retried.
- **Guardrails.** Deterministic rules such as `MONETARY_THRESHOLD_EXCEEDED` are always merged into the model's flags, so the model can't drop a hard control breach. The prompt also tells the model to treat the evidence as data, as a basic prompt-injection hygiene measure.
- **Cost control.** The embedding is skipped when the description hash hasn't changed, for example when only `monetaryImpact` was edited.

### 2. Asynchronous architecture: MongoDB as the queue
I chose native MongoDB status polling over a message broker. The state lives on the document, so there is no dual-write problem between the database and a queue, and there's no extra infrastructure.
- **Claim.** `findOneAndUpdate({status: PENDING, nextAttemptAt <= now} OR {status: PROCESSING, lockedUntil < now})` sets `PROCESSING`, `lockedBy` and `lockedUntil`, and increments `attempts`. Because the claim is atomic on a single document, two workers can never take the same job (a test covers this with 8 concurrent claimers).
- **Enrich** outside any lock.
- **Commit.** `updateOne` is filtered on `{coreRevision, lockedBy, status: PROCESSING}` and uses targeted `$set` paths for AI-owned fields only. If the entry was edited mid-flight, or the lease was lost, the filter matches nothing and the stale result is discarded. The newer `PENDING` revision is then enriched with fresh data.
- **Crash recovery.** An expired lease makes the job claimable again. `WORKER_LEASE_MS` must exceed the maximum AI call time.
- **Failures.** A failed attempt releases the lease and sets `nextAttemptAt` using exponential backoff. The entry becomes `FAILED` after `maxAttempts`.
- **Latency.** Idle slots sleep for `pollIntervalMs`, but the API wakes them through the `EventBus` as soon as it queues work, so enrichment starts within milliseconds without constant polling.
- **Scaling path.** This approach works well for moderate throughput. For heavier load:
  - Change streams can replace the wake-up nudge across processes.
  - The worker can run as a separate deployment (it's already its own class).
  - Or `claimNext`/`complete` can be swapped for a broker such as SQS, BullMQ or Kafka, keeping the revision check as the idempotency guard.

### 3. Vector match performance
- **Normalisation.** Vectors are L2-normalised when written, so cosine similarity is a plain dot product.
- **Search in the database.** `/similar` runs a single aggregation: it matches the tenant, `COMPLETED` status and correct vector size (index `{tenantId, aiMetadata.status}`), computes the dot product with `$reduce` over the 8 dimensions, then sorts and applies `$limit 3`. Only 3 documents leave MongoDB. This is an exact search, O(n) per tenant, which is fine up to thousands of records per tenant.
- **At scale.** Replace the `$match`/`$reduce` stages with Atlas `$vectorSearch` (an HNSW approximate-nearest-neighbour index filtered by `tenantId`), or with pgvector or a dedicated vector store. The repository method signature stays the same.
- **Local embeddings.** The mock embeddings aren't random. Each of the 8 dimensions is an audit concept (override/approval, procurement, payments, access, journals, payroll, split/duplicate, timing), plus a hashed residual. That makes local similarity meaningful: an override exception's closest match is another override exception, at about 0.95 against about 0.0 for unrelated records. With OpenAI, `text-embedding-3-small` is called with `dimensions: 8`.

### 4. Delta evaluation and fast-tracking
Each field has a policy in `DeltaEvaluator`:

| Field(s) | Path | What happens |
|---|---|---|
| `monetaryImpact`, `description`, `controlId` (what the AI reads) | `AI_REQUEUE` | `$set` the fields, `coreRevision++`, `status=PENDING` |
| `entityName`, `eventType` | `DIRECT_UPDATE` | `$set`, AI untouched |
| `auditorNotes` only | `FAST_TRACK` | one atomic `$set` on `aiMetadata.auditorNotes`; no queue, no AI, a few ms |
| values equal after normalisation | `NO_OP` | nothing is written |
| AI-owned `aiMetadata.*`, `evidenceId`, `tenantId`, … | rejected | **422** |

- **Normalisation.** Inputs are normalised before comparison: whitespace, control ID case and numeric strings. Cosmetic edits therefore never trigger an expensive AI run.
- **Safe fast path.** The fast path needs no lock. `auditorNotes` is written only by humans, and the worker's commit `$set`s only AI-owned paths, so a note saved mid-enrichment survives (a test covers this).
- **Evidence edits.** These use optimistic concurrency on `coreRevision`. The controller retries up to 3 times on conflict, so the delta is always computed against the version being replaced.
- **Stale results.** A core edit during enrichment bumps the revision, which makes the in-flight result stale. That result is discarded and the entry is re-enriched. While this happens, the dashboard keeps showing the previous analysis dimmed with a "recomputing" label rather than blanking it.

## Deploying to Vercel

`vercel.json` builds the React client as static files and serves the same Express app from one serverless function (`api/index.js`). A serverless function has no long-lived process, so two things work differently there:

| | `npm run dev` / `npm start` | Vercel |
|---|---|---|
| Worker | Long-lived `AIWorkerService` loop, woken by `EventBus` | `worker.drain()` runs after each write through `waitUntil`, and polling dashboards call `POST /api/worker/drain` as a backup |
| Live updates | Server-Sent Events | Dashboard auto-refreshes (2 s while jobs are in flight, 8 s when idle). `/api/health` reports `runtime: "serverless"` |
| MongoDB | Embedded or `MONGO_URI` | `MONGO_URI` is required |

The queue protocol is the same in both setups: atomic claims, leases, and revision-guarded commits. So concurrent drains in different function instances are safe (covered by a test), and a function killed mid-job is recovered once its lease expires.

Required environment variables on Vercel:
- `MONGO_URI`
- `MOCK_AI=false` and `OPENAI_API_KEY`, or just `MOCK_AI=true`

Atlas must allow Vercel's dynamic IP addresses. Under Network Access, add `0.0.0.0/0`, or use Vercel's Atlas integration.

## Tests

`npm test` runs `node:test` against a real in-memory `mongod`. It covers:
- exclusive claims under concurrency
- stale-result rejection after a mid-flight edit
- fast-track notes surviving the AI commit
- lease-expiry recovery
- retry, backoff and `FAILED`
- the full HTTP flow (POST → PENDING → COMPLETED, every PUT path, 409/422/400)
- top-3 similarity
- delta rules, LLM output sanitisation, fallback, and vector reuse

## Demo script (for the walkthrough video)
1. Run `npm run dev`, open http://localhost:5173, then run `npm run seed -- --extended`. The rows appear as **PENDING**, flip to **Analyzing**, then show their risk badge, score, AI summary, flags and vector bars. The activity feed on the right logs each step.
2. **+ Ingest evidence → Fill sample → Ingest.** The new row goes through the same PENDING → risk-level lifecycle live.
3. Type an auditor note and click **⚡ Save**. The toast reads "Fast-tracked: notes saved in a few ms. AI pipeline skipped", and the status, score and `rev` stay unchanged.
4. Click **✎ Edit evidence**, change the amount, then **Save & re-analyze**. The row goes back to PENDING with the old analysis dimmed, then gets a new score at `rev 2`. The note is kept.
5. Click **≈ Similar** to see the top 3 historical exceptions with their similarity scores.

## Trade-offs / next steps
- Real authentication (JWT tenant claim) instead of the `x-tenant-id` header.
- `EventBus` is in-process. For multiple instances, use change streams or Redis pub/sub. Correctness doesn't depend on it, because workers poll and dashboards resync.
- Store full enrichment history (append-only) for audit trail and model-drift review.
- Lease heartbeats for long LLM calls instead of a fixed generous lease.
