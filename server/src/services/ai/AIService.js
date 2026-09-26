import { MockAIProvider } from './providers/MockAIProvider.js';
import { OpenAIProvider } from './providers/OpenAIProvider.js';
import { RateLimiter } from './RateLimiter.js';
import { evaluateRules, riskLevelFor, RULE_OWNED_FLAGS } from './RiskRules.js';
import { sanitizeVector, vectorSourceHash, VECTOR_DIMS } from './vector.js';
import { silentLogger } from '../../lib/logger.js';

const MAX_FLAGS = 12;

/**
 * Facade over the AI provider. Owns everything provider-agnostic:
 *   - rate limiting (shared token bucket across worker slots)
 *   - fallback to the local engine when the LLM is down / out of quota
 *   - validation + normalisation of model output (never trust raw JSON)
 *   - rule-based guardrail flags merged into model flags
 *   - skipping re-embedding when the description text did not change
 */
export class AIService {
  constructor({ provider, fallback = null, rateLimiter = null, logger = silentLogger }) {
    this.provider = provider;
    this.fallback = fallback;
    this.rateLimiter = rateLimiter;
    this.log = logger;
  }

  static fromConfig(ai, logger = silentLogger) {
    const mock = new MockAIProvider({ delayMs: ai.mockDelayMs, failureRate: ai.mockFailureRate });
    if (ai.mock || !ai.openaiApiKey) {
      if (!ai.mock) logger.warn('MOCK_AI=false but OPENAI_API_KEY is empty - using local AI engine');
      return new AIService({ provider: mock, logger });
    }
    const openai = new OpenAIProvider({
      apiKey: ai.openaiApiKey,
      baseUrl: ai.openaiBaseUrl,
      model: ai.openaiModel,
      embeddingModel: ai.openaiEmbeddingModel,
      timeoutMs: ai.requestTimeoutMs,
    });
    return new AIService({
      provider: openai,
      fallback: ai.fallbackToMock ? new MockAIProvider({ delayMs: 0 }) : null,
      rateLimiter: new RateLimiter({ ratePerMinute: ai.maxRpm }),
      logger,
    });
  }

  describe() {
    return {
      provider: this.provider.name,
      model: this.provider.model,
      fallback: this.fallback ? this.fallback.name : null,
    };
  }

  static buildInput(entry) {
    return {
      evidenceId: entry.evidenceId,
      eventType: entry.eventType,
      entityName: entry.entityName,
      description: entry.description,
      monetaryImpact: entry.monetaryImpact,
      controlId: entry.controlId,
      timestamp: new Date(entry.timestamp).toISOString(),
    };
  }

  async #call(method, arg, trace) {
    if (this.rateLimiter) await this.rateLimiter.acquire();
    try {
      return await this.provider[method](arg);
    } catch (err) {
      if (!this.fallback) throw err;
      this.log.warn(`${this.provider.name}.${method} failed, using fallback`, { error: err.message });
      trace.fallback = true;
      return this.fallback[method](arg);
    }
  }

  static #normaliseAssessment(raw) {
    const score = Number(raw?.riskScore);
    const summary = typeof raw?.aiSummary === 'string' ? raw.aiSummary.trim() : '';
    if (!Number.isFinite(score)) throw new Error('AI output missing numeric riskScore');
    if (!summary) throw new Error('AI output missing aiSummary');
    const flags = Array.isArray(raw.anomalyFlags) ? raw.anomalyFlags : [];
    return {
      riskScore: Math.max(0, Math.min(100, Math.round(score))),
      aiSummary: summary.slice(0, 600),
      anomalyFlags: flags
        .filter((f) => typeof f === 'string')
        .map((f) => f.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, ''))
        .filter(Boolean),
    };
  }

  /**
   * Full enrichment for one entry. Risk assessment and embedding run in
   * parallel; the embedding is reused when the description is unchanged
   * (e.g. only monetaryImpact was edited).
   */
  async enrich(entry) {
    const input = AIService.buildInput(entry);
    const hash = vectorSourceHash(input.description);
    const prev = entry.aiMetadata ?? {};
    const reuseVector = prev.vectorSourceHash === hash && prev.semanticVector?.length === VECTOR_DIMS;
    const trace = { fallback: false };

    const [rawAssessment, rawVector] = await Promise.all([
      this.#call('assessRisk', input, trace),
      reuseVector ? prev.semanticVector : this.#call('embed', input.description, trace),
    ]);

    const assessment = AIService.#normaliseAssessment(rawAssessment);
    const guardrail = evaluateRules(input);
    const modelFlags = assessment.anomalyFlags.filter((f) => !RULE_OWNED_FLAGS.has(f));
    const anomalyFlags = [...new Set([...guardrail.flags, ...modelFlags])].slice(0, MAX_FLAGS);

    return {
      riskScore: assessment.riskScore,
      riskLevel: riskLevelFor(assessment.riskScore),
      aiSummary: assessment.aiSummary,
      anomalyFlags,
      semanticVector: sanitizeVector(rawVector),
      vectorSourceHash: hash,
      vectorReused: reuseVector,
      provider: trace.fallback ? `${this.provider.name}+fallback` : this.provider.name,
      model: this.provider.model,
    };
  }
}
