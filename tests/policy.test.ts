import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loanFactsSchema, type LoanFacts, type ValidationIssue } from '../src/contracts.js';
import { applyEducationalOverride, canonicalJson, computePaymentCents, DEMO_POLICY, evaluatePolicy } from '../src/policy.js';

function facts(patch: Partial<LoanFacts> = {}): LoanFacts {
  return {
    grossMonthlyIncomeCents: 1_000_000, existingMonthlyDebtCents: 100_000,
    financedAmountCents: 6_000_000, vehicleCashPriceCents: 6_000_000,
    proposedMonthlyPaymentCents: 100_000, termMonths: 60, aprBps: 0, creditScore: 740,
    debtExcludesProposedLoan: true, cashPriceExcludesExtras: true, fixedApr: true,
    ...patch,
  };
}

describe('immutable teaching policy', () => {
  it('has a hash tied to the entire canonical snapshot and deeply frozen thresholds', () => {
    const { hash, ...snapshot } = DEMO_POLICY;
    expect(createHash('sha256').update(canonicalJson(snapshot)).digest('hex')).toBe(hash);
    expect(Object.isFrozen(DEMO_POLICY)).toBe(true);
    for (const value of [DEMO_POLICY.credit, DEMO_POLICY.dti, DEMO_POLICY.ltv, DEMO_POLICY.terms]) expect(Object.isFrozen(value)).toBe(true);
    expect(() => { DEMO_POLICY.credit.passMin = 600; }).toThrow();
  });

  it('rejects altered thresholds or audit hashes presented as the same pinned version', () => {
    const changedThreshold = { ...DEMO_POLICY, credit: { ...DEMO_POLICY.credit, passMin: 300 } };
    const changedHash = { ...DEMO_POLICY, hash: '0'.repeat(64) };
    expect(() => evaluatePolicy(facts(), [], changedThreshold)).toThrow('pinned policy snapshot');
    expect(() => evaluatePolicy(facts(), [], changedHash)).toThrow('pinned policy snapshot');
    expect(evaluatePolicy(facts(), [], JSON.parse(JSON.stringify(DEMO_POLICY))).outcome).toBe('PASS');
  });
});

describe('exact policy bands', () => {
  it.each([
    [639, 'FAIL', 'CREDIT_BELOW_MINIMUM'], [640, 'REVIEW', 'CREDIT_BORDERLINE'],
    [699, 'REVIEW', 'CREDIT_BORDERLINE'], [700, 'PASS', null], [850, 'PASS', null],
  ] as const)('credit %i yields %s', (creditScore, outcome, reason) => {
    const result = evaluatePolicy(facts({ creditScore }));
    expect(result.outcome).toBe(outcome);
    expect(result.reasonCodes).toEqual(reason === null ? [] : [reason]);
    expect(result.rules.find(rule => rule.id === 'credit')?.value).toBe(creditScore);
  });

  it.each([
    [260_000, 'PASS', null], [260_001, 'REVIEW', 'DTI_BORDERLINE'],
    [350_000, 'REVIEW', 'DTI_BORDERLINE'], [350_001, 'FAIL', 'DTI_ABOVE_MAXIMUM'],
  ] as const)('DTI debt %i with $1000 payment yields %s without ratio rounding', (existingMonthlyDebtCents, outcome, reason) => {
    const result = evaluatePolicy(facts({ existingMonthlyDebtCents }));
    expect(result.outcome).toBe(outcome);
    expect(result.reasonCodes).toEqual(reason === null ? [] : [reason]);
    expect(result.rules.find(rule => rule.id === 'dti')).toMatchObject({
      numerator: existingMonthlyDebtCents + 100_000, denominator: 1_000_000,
      thresholds: { passBps: 3600, reviewMaxBps: 4500 },
    });
  });

  it.each([
    [6_000_000, 'PASS', null], [6_000_001, 'REVIEW', 'LTV_BORDERLINE'],
    [6_600_000, 'REVIEW', 'LTV_BORDERLINE'], [6_600_001, 'FAIL', 'LTV_ABOVE_MAXIMUM'],
  ] as const)('LTV financed cents %i yields %s without ratio rounding', (financedAmountCents, outcome, reason) => {
    const result = evaluatePolicy(facts({ financedAmountCents, proposedMonthlyPaymentCents: Math.round(financedAmountCents / 60) }));
    expect(result.outcome).toBe(outcome);
    expect(result.reasonCodes).toEqual(reason === null ? [] : [reason]);
    expect(result.rules.find(rule => rule.id === 'ltv')).toMatchObject({
      numerator: financedAmountCents, denominator: 6_000_000,
      thresholds: { passBps: 10_000, reviewMaxBps: 11_000 },
    });
  });

  it('preserves all failing financial rules and their raw values', () => {
    const result = evaluatePolicy(facts({ creditScore: 639, existingMonthlyDebtCents: 900_000, vehicleCashPriceCents: 5_000_000 }));
    expect(result.outcome).toBe('FAIL');
    expect(result.reasonCodes).toEqual(['CREDIT_BELOW_MINIMUM', 'DTI_ABOVE_MAXIMUM', 'LTV_ABOVE_MAXIMUM']);
    expect(result.rules).toHaveLength(5);
    expect(result.rules.filter(rule => rule.band === 'FAIL')).toHaveLength(3);
  });

  it('retains borderline explanations when a different financial rule fails', () => {
    expect(evaluatePolicy(facts({ creditScore: 639, existingMonthlyDebtCents: 300_000 })).reasonCodes)
      .toEqual(['CREDIT_BELOW_MINIMUM', 'DTI_BORDERLINE']);
  });

  it('uses exact big integer cross multiplication for large safe integer values', () => {
    const principal = 7_000_000_000_000_000;
    const result = evaluatePolicy(facts({
      financedAmountCents: principal, vehicleCashPriceCents: principal,
      grossMonthlyIncomeCents: 8_000_000_000_000_000,
      proposedMonthlyPaymentCents: computePaymentCents(principal, 0, 60),
    }));
    expect(result.outcome).toBe('PASS');
  });
});

describe('evidence and arithmetic gates', () => {
  it.each([
    'EVIDENCE_CONFLICT', 'OCR_LOW_CONFIDENCE', 'VERIFICATION_REQUIRED', 'CITATION_INVALID', 'OCR_CONFIDENCE_MISSING',
  ] as const)('%s takes precedence over a visible failing credit score', code => {
    const issues: ValidationIssue[] = [{ code, message: 'Source needs review' }];
    const result = evaluatePolicy(facts({ creditScore: 300 }), issues);
    expect(result.outcome).toBe('REVIEW');
    expect(result.reasonCodes).toContain(code);
    expect(result.reasonCodes).not.toContain('CREDIT_BELOW_MINIMUM');
    expect(result.rules.filter(rule => ['credit', 'dti', 'ltv'].includes(rule.id)).every(rule => rule.band === 'NOT_EVALUATED')).toBe(true);
  });

  it.each(['grossMonthlyIncomeCents', 'vehicleCashPriceCents'] as const)('null and zero %s never become financial FAIL', name => {
    expect(evaluatePolicy(facts({ [name]: null, creditScore: 300 })).outcome).toBe('REVIEW');
    expect(evaluatePolicy(facts({ [name]: 0, creditScore: 300 })).reasonCodes).toContain('DOMAIN_INVALID');
  });

  it.each([
    { existingMonthlyDebtCents: -1 }, { grossMonthlyIncomeCents: -1 }, { proposedMonthlyPaymentCents: -1 },
    { financedAmountCents: -1 }, { vehicleCashPriceCents: -1 }, { creditScore: 299 }, { creditScore: 851 },
  ])('invalid domain %j requires REVIEW', patch => {
    const result = evaluatePolicy(facts(patch));
    expect(result.outcome).toBe('REVIEW');
    expect(result.reasonCodes).toContain('DOMAIN_INVALID');
  });

  it.each([
    { termMonths: 35 }, { termMonths: 85 }, { aprBps: -1 }, { aprBps: 3001 }, { fixedApr: false },
  ])('unsupported terms %j require REVIEW', patch => {
    expect(evaluatePolicy(facts(patch)).reasonCodes).toContain('UNSUPPORTED_TERMS');
    expect(evaluatePolicy(facts(patch)).outcome).toBe('REVIEW');
  });

  it.each([36, 84])('supported term %i and maximum APR can pass', termMonths => {
    const loan = facts({ termMonths, aprBps: 3000 });
    loan.proposedMonthlyPaymentCents = computePaymentCents(loan.financedAmountCents!, 3000, termMonths);
    expect(evaluatePolicy(loan).outcome).toBe('PASS');
  });

  it.each([100, -100])('payment tolerance includes exactly %i cents', difference => {
    expect(evaluatePolicy(facts({ proposedMonthlyPaymentCents: 100_000 + difference })).outcome).toBe('PASS');
  });
  it.each([101, -101])('payment tolerance excludes %i cents even with financial failure', difference => {
    const result = evaluatePolicy(facts({ proposedMonthlyPaymentCents: 100_000 + difference, creditScore: 300 }));
    expect(result.outcome).toBe('REVIEW');
    expect(result.reasonCodes).toContain('PAYMENT_MISMATCH');
    expect(result.reasonCodes).not.toContain('CREDIT_BELOW_MINIMUM');
  });

  it('requires explicit exclusion definitions for debt and cash price', () => {
    expect(evaluatePolicy(facts({ debtExcludesProposedLoan: null })).reasonCodes).toContain('DEBT_DOUBLE_COUNTING');
    expect(evaluatePolicy(facts({ cashPriceExcludesExtras: false })).reasonCodes).toContain('CASH_PRICE_AMBIGUOUS');
  });

  it('rejects fractional, unsafe, NaN, nonnumeric, missing, and identity-bearing schemas', () => {
    for (const value of [7.4, Number.MAX_SAFE_INTEGER + 1, NaN, '740', undefined]) {
      expect(evaluatePolicy({ ...facts(), creditScore: value }).reasonCodes).toContain('SCHEMA_INVALID');
    }
    expect(loanFactsSchema.safeParse({ ...facts(), race: 'invented', name: 'FICTIONAL NAME' }).success).toBe(false);
  });

  it('reviews a debt/payment sum that would lose integer precision', () => {
    const result = evaluatePolicy(facts({ existingMonthlyDebtCents: Number.MAX_SAFE_INTEGER }));
    expect(result.reasonCodes).toContain('DOMAIN_INVALID');
  });

  it('does not mutate facts or issue arrays', () => {
    const loan = Object.freeze(facts());
    const issues = Object.freeze([{ code: 'EVIDENCE_CONFLICT' as const, message: 'Conflict' }]);
    expect(evaluatePolicy(loan, issues).outcome).toBe('REVIEW');
    expect(loan.creditScore).toBe(740);
  });
});

describe('amortization and explicit educational overrides', () => {
  it('implements zero APR separately and fixed-rate amortization', () => {
    expect(computePaymentCents(6_000_000, 0, 60)).toBe(100_000);
    expect(computePaymentCents(6_500_000, 650, 72)).toBe(109_265);
    expect(computePaymentCents(0, 650, 72)).toBe(0);
    expect(computePaymentCents(6_000_000, 1, 60)).toBe(100_025);
    expect(() => computePaymentCents(10, 0, 0)).toThrow();
    expect(() => computePaymentCents(-10, 0, 60)).toThrow();
  });

  it('preserves failures and original recommendation under a labeled override', () => {
    const original = evaluatePolicy(facts({ creditScore: 300 }));
    const result = applyEducationalOverride(original, { action: 'educational_override', role: 'override_reviewer', decision: 'PASS', reason: 'Educational walkthrough' });
    expect(result.finalDecision).toBe('PASS');
    expect(result.label).toBe('OVERRIDE');
    expect(result.authority).toBe('educational_reviewer_override');
    expect(result.originalRecommendation.outcome).toBe('FAIL');
    expect(result.originalRecommendation.reasonCodes).toContain('CREDIT_BELOW_MINIMUM');
    expect(original.outcome).toBe('FAIL');
  });

  it('requires an override-capable role and a separate reasoned action', () => {
    const recommendation = evaluatePolicy(facts());
    expect(() => applyEducationalOverride(recommendation, { action: 'educational_override', role: 'reviewer', decision: 'FAIL', reason: 'Reason' })).toThrow();
    expect(() => applyEducationalOverride(recommendation, { action: 'educational_override', role: 'override_reviewer', decision: 'FAIL', reason: ' ' })).toThrow();
  });
});
