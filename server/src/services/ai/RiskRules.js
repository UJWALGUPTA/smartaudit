/**
 * Deterministic audit heuristics. They drive the local simulation engine and
 * also act as guardrails for LLM output: rule-detected flags are always merged
 * in, so a model that "forgets" a $50k threshold breach cannot hide it.
 */
export const MONETARY_THRESHOLD = 50_000;

const RULES = [
  {
    flag: 'MONETARY_THRESHOLD_EXCEEDED',
    weight: 10,
    reason: (e) => `exceeds the $${MONETARY_THRESHOLD.toLocaleString('en-US')} approval threshold`,
    test: (e) => e.monetaryImpact >= MONETARY_THRESHOLD,
  },
  {
    flag: 'MANUAL_OVERRIDE',
    weight: 18,
    reason: () => 'a manual override bypassed the standard control',
    test: (e) => /\b(overrid\w*|bypass\w*|circumvent\w*|forced?)\b/i.test(e.description),
  },
  {
    flag: 'SEGREGATION_OF_DUTIES_RISK',
    weight: 20,
    reason: () => 'the same actor both initiated and approved the activity',
    test: (e) => /\b(self[- ]approv\w*|own (request|invoice|payment)|same user|approved by (the )?requester|sod)\b/i.test(e.description),
  },
  {
    flag: 'MISSING_APPROVAL_EVIDENCE',
    weight: 18,
    reason: () => 'no approval or ticket evidence was recorded',
    test: (e) => /\bwithout (a |any )?(manager |proper |prior |documented )?(approval|ticket|authori[sz]ation|sign[- ]?off)\b/i.test(e.description),
  },
  {
    flag: 'POTENTIAL_SPLIT_TRANSACTION',
    weight: 15,
    reason: () => 'the pattern suggests splitting to stay under approval limits',
    test: (e) => /\b(split|multiple (invoices|payments)|just below|structur\w*)\b/i.test(e.description),
  },
  {
    flag: 'DUPLICATE_PAYMENT_RISK',
    weight: 15,
    reason: () => 'it may duplicate a previously processed payment',
    test: (e) => /\b(duplicate|repeated|paid twice)\b/i.test(e.description),
  },
  {
    flag: 'PRIVILEGED_ACCESS_CHANGE',
    weight: 15,
    reason: () => 'it involves a privileged access change',
    test: (e) => /\b(admin\w*|privilege\w*|superuser|root access|elevated)\b/i.test(e.description),
  },
  {
    flag: 'BACKDATED_ENTRY',
    weight: 12,
    reason: () => 'the entry appears to be backdated',
    test: (e) => /\bback[- ]?dat\w*\b/i.test(e.description),
  },
  {
    flag: 'OFF_HOURS_ACTIVITY',
    weight: 8,
    reason: () => 'it occurred outside normal business hours',
    test: (e) => {
      const d = new Date(e.timestamp);
      const hour = d.getUTCHours();
      const weekend = [0, 6].includes(d.getUTCDay());
      return weekend || hour < 6 || hour >= 22 || /\b(weekend|after[- ]hours|midnight)\b/i.test(e.description);
    },
  },
  {
    flag: 'ROUND_AMOUNT',
    weight: 5,
    reason: () => 'the amount is a suspiciously round figure',
    test: (e) => e.monetaryImpact >= 10_000 && e.monetaryImpact % 5_000 === 0,
  },
  {
    flag: 'UNUSUAL_DESCRIPTION_PATTERN',
    weight: 10,
    reason: () => 'the justification is vague or pressure-driven',
    test: (e) =>
      e.description.trim().length < 20 ||
      /\b(urgent|asap|confidential|verbal(ly)? approv\w*|do not (disclose|escalate)|per ceo|exception granted)\b/i.test(e.description),
  },
  {
    flag: 'KEY_CONTROL_AFFECTED',
    weight: 7,
    reason: (e) => `it touches key control ${e.controlId}`,
    test: (e) => /^CTRL-(FIN|SOD|ITGC|TRE)/i.test(e.controlId),
  },
];

/**
 * Flags derived purely from structured fields. The rules are authoritative
 * for these: an LLM may not add them (e.g. because free text *claims* ">$50k"
 * after the amount was corrected to $4,500) nor remove them.
 */
export const RULE_OWNED_FLAGS = new Set(['MONETARY_THRESHOLD_EXCEEDED', 'ROUND_AMOUNT', 'KEY_CONTROL_AFFECTED']);

export function amountScore(amount) {
  if (amount >= 250_000) return 45;
  if (amount >= 50_000) return 35;
  if (amount >= 10_000) return 22;
  if (amount >= 1_000) return 12;
  return amount > 0 ? 5 : 0;
}

export function riskLevelFor(score) {
  if (score >= 80) return 'CRITICAL';
  if (score >= 60) return 'HIGH';
  if (score >= 30) return 'MEDIUM';
  return 'LOW';
}

export function evaluateRules(entry) {
  const hits = RULES.filter((r) => r.test(entry));
  const score = Math.min(100, amountScore(entry.monetaryImpact) + hits.reduce((s, r) => s + r.weight, 0));
  return {
    score,
    level: riskLevelFor(score),
    flags: hits.map((r) => r.flag),
    reasons: hits.sort((a, b) => b.weight - a.weight).map((r) => r.reason(entry)),
  };
}
