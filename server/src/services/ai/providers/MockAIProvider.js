import { evaluateRules } from '../RiskRules.js';
import { localEmbedding } from '../vector.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/**
 * Local AI simulation engine: deterministic scoring + templated synthesis,
 * with realistic latency and optional injected failures (to exercise the
 * worker's retry path without a real provider).
 */
export class MockAIProvider {
  constructor({ delayMs = 400, failureRate = 0 } = {}) {
    this.name = 'mock';
    this.model = 'local-risk-engine-v1';
    this.delayMs = delayMs;
    this.failureRate = failureRate;
  }

  async #simulateLatency() {
    await sleep(this.delayMs);
    if (this.failureRate > 0 && Math.random() < this.failureRate) {
      throw new Error('mock AI engine: simulated transient failure');
    }
  }

  async assessRisk(input) {
    await this.#simulateLatency();
    const { score, level, flags, reasons } = evaluateRules(input);

    const lead = `${level.charAt(0)}${level.slice(1).toLowerCase()} risk: ${input.entityName} recorded a ${usd(
      input.monetaryImpact,
    )} ${input.eventType.toLowerCase()} under ${input.controlId}`;
    const why = reasons.length
      ? `, flagged because ${reasons.slice(0, 2).join(' and ')}.`
      : ', with no anomaly signals beyond routine activity.';
    const followUp =
      level === 'LOW' ? '' : ' Recommend reviewing supporting approvals and evidence of secondary sign-off.';

    return { riskScore: score, aiSummary: `${lead}${why}${followUp}`, anomalyFlags: flags };
  }

  async embed(text) {
    await sleep(Math.round(this.delayMs / 4));
    return localEmbedding(text);
  }
}
