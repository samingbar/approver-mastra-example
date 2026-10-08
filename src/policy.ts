import {
  fieldNames, loanFactsSchema, policySnapshotSchema, validationIssueSchema,
  type LoanFacts, type PolicyDecision, type PolicySnapshot, type ReasonCode,
  type RuleResult, type ValidationIssue,
} from './contracts.js';

// SHA-256 of the canonical, recursively key-sorted snapshot without its hash field.
// The integrity test prevents changing thresholds without changing this audit identity.
export const DEMO_POLICY: Readonly<PolicySnapshot> = Object.freeze({
  version: 'demo-auto-loan-v1',
  hash: 'a1f37ecdff5a414f934c92e08cdc436c7c6067aadc845ed5e5bae68612c9f42f',
  credit: Object.freeze({ min: 300, max: 850, passMin: 700, reviewMin: 640 }),
  dti: Object.freeze({ passBps: 3600, reviewMaxBps: 4500 }),
  ltv: Object.freeze({ passBps: 10000, reviewMaxBps: 11000 }),
  terms: Object.freeze({ minMonths: 36, maxMonths: 84, maxAprBps: 3000, paymentToleranceCents: 100 }),
  minimumOcrConfidence: 90,
});

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Canonical JSON does not accept undefined');
  return encoded;
}

export function computePaymentCents(principalCents: number, aprBps: number, termMonths: number): number {
  if (!Number.isSafeInteger(principalCents) || principalCents < 0
    || !Number.isSafeInteger(aprBps) || aprBps < 0
    || !Number.isSafeInteger(termMonths) || termMonths <= 0) {
    throw new RangeError('Payment requires nonnegative integer principal/APR and a positive integer term');
  }
  if (aprBps === 0) return Math.round(principalCents / termMonths);
  const monthlyRate = aprBps / 10_000 / 12;
  // expm1/log1p avoid loss of precision at small, nonzero interest rates.
  const denominator = -Math.expm1(-termMonths * Math.log1p(monthlyRate));
  return Math.round(principalCents * monthlyRate / denominator);
}

function unique(codes: ReasonCode[]): ReasonCode[] { return [...new Set(codes)]; }

function decision(outcome: PolicyDecision['outcome'], rules: RuleResult[], snapshot: PolicySnapshot): PolicyDecision {
  return {
    outcome, reasonCodes: unique(rules.flatMap(rule => rule.reasonCodes)), rules,
    policyVersion: snapshot.version, policyHash: snapshot.hash, educationalSimulation: true,
  };
}

function compareRatio(numerator: number, denominator: number, thresholdBps: number): number {
  const left = BigInt(numerator) * 10_000n;
  const right = BigInt(denominator) * BigInt(thresholdBps);
  return left < right ? -1 : left > right ? 1 : 0;
}

function ratioRule(
  id: 'dti' | 'ltv', numerator: number, denominator: number,
  thresholds: { passBps: number; reviewMaxBps: number },
): RuleResult {
  const band = compareRatio(numerator, denominator, thresholds.passBps) <= 0 ? 'PASS'
    : compareRatio(numerator, denominator, thresholds.reviewMaxBps) <= 0 ? 'REVIEW' : 'FAIL';
  const review: ReasonCode = id === 'dti' ? 'DTI_BORDERLINE' : 'LTV_BORDERLINE';
  const fail: ReasonCode = id === 'dti' ? 'DTI_ABOVE_MAXIMUM' : 'LTV_ABOVE_MAXIMUM';
  return { id, band, reasonCodes: band === 'PASS' ? [] : [band === 'FAIL' ? fail : review], numerator, denominator, thresholds };
}

function notEvaluated(snapshot: PolicySnapshot): RuleResult[] {
  return [
    { id: 'credit', band: 'NOT_EVALUATED', reasonCodes: [], thresholds: { ...snapshot.credit } },
    { id: 'dti', band: 'NOT_EVALUATED', reasonCodes: [], thresholds: { ...snapshot.dti } },
    { id: 'ltv', band: 'NOT_EVALUATED', reasonCodes: [], thresholds: { ...snapshot.ltv } },
  ];
}

/** Deterministic educational recommendation. Evidence and arithmetic always gate financial bands. */
export function evaluatePolicy(
  input: unknown, evidenceIssues: readonly ValidationIssue[] = [], snapshot: PolicySnapshot = DEMO_POLICY,
): PolicyDecision {
  policySnapshotSchema.parse(snapshot);
  if (canonicalJson(snapshot) !== canonicalJson(DEMO_POLICY)) {
    throw new RangeError('The pinned policy snapshot does not match its supported version and hash');
  }
  const parsed = loanFactsSchema.safeParse(input);
  const parsedIssues = validationIssueSchema.array().safeParse(evidenceIssues);
  if (!parsed.success || !parsedIssues.success) {
    return decision('REVIEW', [
      { id: 'evidence', band: 'REVIEW', reasonCodes: ['SCHEMA_INVALID'], thresholds: { minimumOcrConfidence: snapshot.minimumOcrConfidence } },
      { id: 'terms', band: 'NOT_EVALUATED', reasonCodes: [], thresholds: { ...snapshot.terms } },
      ...notEvaluated(snapshot),
    ], snapshot);
  }
  const facts = parsed.data;
  const gateCodes = parsedIssues.data.map(issue => issue.code);
  const termCodes: ReasonCode[] = [];
  for (const name of fieldNames) {
    if (facts[name] === null) gateCodes.push('EVIDENCE_MISSING');
  }
  const moneyFields = [
    'grossMonthlyIncomeCents', 'existingMonthlyDebtCents', 'financedAmountCents',
    'vehicleCashPriceCents', 'proposedMonthlyPaymentCents',
  ] as const;
  for (const name of moneyFields) {
    const value = facts[name];
    if (value !== null && (value < 0 || ((name === 'grossMonthlyIncomeCents' || name === 'vehicleCashPriceCents') && value === 0))) {
      gateCodes.push('DOMAIN_INVALID');
    }
  }
  if (facts.creditScore !== null && (facts.creditScore < snapshot.credit.min || facts.creditScore > snapshot.credit.max)) gateCodes.push('DOMAIN_INVALID');
  if (facts.debtExcludesProposedLoan !== true) gateCodes.push('DEBT_DOUBLE_COUNTING');
  if (facts.cashPriceExcludesExtras !== true) gateCodes.push('CASH_PRICE_AMBIGUOUS');
  if (facts.fixedApr !== true) termCodes.push('UNSUPPORTED_TERMS');
  if (facts.termMonths !== null && (facts.termMonths < snapshot.terms.minMonths || facts.termMonths > snapshot.terms.maxMonths)) termCodes.push('UNSUPPORTED_TERMS');
  if (facts.aprBps !== null && (facts.aprBps < 0 || facts.aprBps > snapshot.terms.maxAprBps)) termCodes.push('UNSUPPORTED_TERMS');

  let computedPaymentCents: number | undefined;
  if (facts.financedAmountCents !== null && facts.financedAmountCents >= 0
    && facts.termMonths !== null && facts.termMonths >= snapshot.terms.minMonths && facts.termMonths <= snapshot.terms.maxMonths
    && facts.aprBps !== null && facts.aprBps >= 0 && facts.aprBps <= snapshot.terms.maxAprBps && facts.fixedApr === true) {
    computedPaymentCents = computePaymentCents(facts.financedAmountCents, facts.aprBps, facts.termMonths);
    if (facts.proposedMonthlyPaymentCents !== null && Math.abs(facts.proposedMonthlyPaymentCents - computedPaymentCents) > snapshot.terms.paymentToleranceCents) termCodes.push('PAYMENT_MISMATCH');
  }
  if (facts.existingMonthlyDebtCents !== null && facts.proposedMonthlyPaymentCents !== null
    && !Number.isSafeInteger(facts.existingMonthlyDebtCents + facts.proposedMonthlyPaymentCents)) gateCodes.push('DOMAIN_INVALID');
  const evidence: RuleResult = {
    id: 'evidence', band: gateCodes.length === 0 ? 'PASS' : 'REVIEW',
    reasonCodes: unique(gateCodes), thresholds: { minimumOcrConfidence: snapshot.minimumOcrConfidence },
  };
  const terms: RuleResult = {
    id: 'terms', band: termCodes.length === 0 ? 'PASS' : 'REVIEW', reasonCodes: unique(termCodes),
    thresholds: { ...snapshot.terms, ...(computedPaymentCents === undefined ? {} : { computedPaymentCents }) },
  };
  if (gateCodes.length !== 0 || termCodes.length !== 0) return decision('REVIEW', [evidence, terms, ...notEvaluated(snapshot)], snapshot);

  // The evidence gate above proves all numeric fields present; keep its proof local.
  const complete = facts as { [K in keyof LoanFacts]: NonNullable<LoanFacts[K]> };
  const creditBand = complete.creditScore >= snapshot.credit.passMin ? 'PASS'
    : complete.creditScore >= snapshot.credit.reviewMin ? 'REVIEW' : 'FAIL';
  const credit: RuleResult = {
    id: 'credit', band: creditBand, value: complete.creditScore, thresholds: { ...snapshot.credit },
    reasonCodes: creditBand === 'PASS' ? [] : [creditBand === 'FAIL' ? 'CREDIT_BELOW_MINIMUM' : 'CREDIT_BORDERLINE'],
  };
  const dti = ratioRule('dti', complete.existingMonthlyDebtCents + complete.proposedMonthlyPaymentCents, complete.grossMonthlyIncomeCents, snapshot.dti);
  const ltv = ratioRule('ltv', complete.financedAmountCents, complete.vehicleCashPriceCents, snapshot.ltv);
  const rules = [evidence, terms, credit, dti, ltv];
  return decision(rules.some(rule => rule.band === 'FAIL') ? 'FAIL'
    : rules.some(rule => rule.band === 'REVIEW') ? 'REVIEW' : 'PASS', rules, snapshot);
}

export interface ReviewerOverride {
  action: 'educational_override'; role: 'reviewer' | 'override_reviewer';
  decision: 'PASS' | 'FAIL'; reason: string;
}
export interface OverriddenDecision {
  originalRecommendation: PolicyDecision; finalDecision: 'PASS' | 'FAIL';
  authority: 'educational_reviewer_override'; override: true; label: 'OVERRIDE'; reason: string;
}

/** Override leaves every original rule and failure intact and never masquerades as compliance. */
export function applyEducationalOverride(originalRecommendation: PolicyDecision, command: ReviewerOverride): OverriddenDecision {
  if (command.action !== 'educational_override' || command.role !== 'override_reviewer'
    || !['PASS', 'FAIL'].includes(command.decision) || command.reason.trim().length === 0) {
    throw new Error('An explicit override action, override-capable reviewer, and reason are required');
  }
  return {
    originalRecommendation, finalDecision: command.decision,
    authority: 'educational_reviewer_override', override: true, label: 'OVERRIDE', reason: command.reason.trim(),
  };
}
