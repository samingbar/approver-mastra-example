import {
  fieldNames, rawExtractionSchema, verificationRecordSchema,
  type Citation, type DocumentSection, type EvidenceValidation, type FieldName,
  type LoanFacts, type OcrBlock, type OcrManifest, type RawExtraction, type RawField,
  type SourcePeriod, type ValidationIssue, type VerificationRecord,
} from './contracts.js';
import { DEMO_POLICY } from './policy.js';

const expectedSections: Record<FieldName, readonly DocumentSection[]> = {
  grossMonthlyIncomeCents: ['income'], existingMonthlyDebtCents: ['debts', 'application'],
  financedAmountCents: ['terms', 'application'], vehicleCashPriceCents: ['terms', 'application'],
  proposedMonthlyPaymentCents: ['terms', 'application'], termMonths: ['terms', 'application'],
  aprBps: ['terms', 'application'], creditScore: ['bureau'],
};
const fieldAnchors: Record<FieldName, RegExp> = {
  grossMonthlyIncomeCents: /gross\s+(?:(?:monthly|weekly|biweekly|semimonthly)\s+)?income\s*:/i,
  existingMonthlyDebtCents: /existing\s+monthly\s+debt(?:\s+payments|\s+obligations)?\s*:/i,
  financedAmountCents: /financed\s+amount\s*:/i,
  vehicleCashPriceCents: /vehicle\s+cash\s+price\s*:/i,
  proposedMonthlyPaymentCents: /proposed\s+monthly\s+payment\s*:/i,
  termMonths: /(?:loan\s+)?term\s*:/i,
  aprBps: /(?:fixed\s+)?apr\s*:/i,
  creditScore: /credit\s+score\s*:/i,
};

interface Fraction { numerator: bigint; denominator: bigint }

function decimalFraction(value: string | number, unit: RawField['unit']): Fraction | null {
  let text = String(value).trim();
  if (unit === 'USD') text = text.replace(/^\$\s*/, '');
  if (unit === 'percent') text = text.replace(/%$/, '');
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  text = text.replaceAll(',', '');
  const negative = text.startsWith('-');
  text = text.replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = text.split('.');
  if (fraction.length > 8 || whole.length > 18) return null;
  return { numerator: BigInt(whole + fraction) * (negative ? -1n : 1n), denominator: 10n ** BigInt(fraction.length) };
}

function integerScale(value: string | number, unit: RawField['unit'], scale: bigint): number | null {
  const fraction = decimalFraction(value, unit);
  if (fraction === null || (fraction.numerator * scale) % fraction.denominator !== 0n) return null;
  const integer = fraction.numerator * scale / fraction.denominator;
  const result = Number(integer);
  return Number.isSafeInteger(result) ? result : null;
}

/** Explicit source frequencies; unsupported annual/unknown frequencies are never guessed. */
export function monthlyIncomeCents(amountCents: number, period: SourcePeriod | null): number | null {
  if (!Number.isSafeInteger(amountCents)) return null;
  const factors: Partial<Record<SourcePeriod, readonly [bigint, bigint]>> = {
    weekly: [52n, 12n], biweekly: [26n, 12n], semimonthly: [2n, 1n], monthly: [1n, 1n],
  };
  const factor = period === null ? undefined : factors[period];
  if (factor === undefined) return null;
  const numerator = BigInt(amountCents) * factor[0];
  const sign = numerator < 0n ? -1n : 1n;
  const magnitude = numerator * sign;
  const rounded = ((magnitude * 2n + factor[1]) / (factor[1] * 2n)) * sign;
  const result = Number(rounded);
  return Number.isSafeInteger(result) ? result : null;
}

export function normalizeField(name: FieldName, field: RawField): number | null {
  if (field.value === null) return null;
  if (name === 'aprBps') {
    if (field.period !== null) return null;
    return field.unit === 'percent' ? integerScale(field.value, field.unit, 100n)
      : field.unit === 'basis_points' ? integerScale(field.value, field.unit, 1n) : null;
  }
  if (name === 'creditScore' || name === 'termMonths') {
    if (field.period !== null || field.unit !== (name === 'creditScore' ? 'score' : 'months')) return null;
    return integerScale(field.value, field.unit, 1n);
  }
  if (field.unit !== 'USD' && field.unit !== 'cents') return null;
  const cents = integerScale(field.value, field.unit, field.unit === 'USD' ? 100n : 1n);
  if (cents === null) return null;
  if (name === 'grossMonthlyIncomeCents') return monthlyIncomeCents(cents, field.period);
  if (name === 'existingMonthlyDebtCents' || name === 'proposedMonthlyPaymentCents') return field.period === 'monthly' ? cents : null;
  return field.period === null ? cents : null;
}

export function emptyExtraction(): RawExtraction {
  const blank = (): RawField => ({ value: null, unit: null, period: null, citations: [], conflictingValues: [] });
  return {
    fields: {
      grossMonthlyIncomeCents: blank(), existingMonthlyDebtCents: blank(), financedAmountCents: blank(),
      vehicleCashPriceCents: blank(), proposedMonthlyPaymentCents: blank(), termMonths: blank(), aprBps: blank(), creditScore: blank(),
    },
    debtExcludesProposedLoan: null, cashPriceExcludesExtras: null, fixedApr: null, notes: [],
  };
}

function numericStrings(text: string): string[] {
  return text.match(/[-+]?\d[\d,]*(?:\.\d+)?%?/g) ?? [];
}

function sameNumericValue(candidate: string, field: RawField): boolean {
  if (field.value === null) return false;
  const expected = decimalFraction(field.value, field.unit);
  const quoted = decimalFraction(candidate, field.unit);
  return expected !== null && quoted !== null
    && expected.numerator * quoted.denominator === quoted.numerator * expected.denominator;
}

function sameBox(citation: Citation, block: OcrBlock): boolean {
  return (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(citation.boundingBox[key] - block.boundingBox[key]) <= 0.01);
}

function sourceUnitMatches(name: FieldName, field: RawField, source: string): boolean {
  if (name === 'termMonths') return field.unit === 'months' && /\bmonths\b/i.test(source);
  if (name === 'creditScore') return field.unit === 'score' && /credit\s+score/i.test(source);
  if (name === 'aprBps') return field.unit === 'percent' ? /%|\bpercent\b/i.test(source)
    : field.unit === 'basis_points' && /\bbps\b|\bbasis\s+points\b/i.test(source);
  return field.unit === 'USD' ? /\$|\bUSD\b|\bdollars\b/i.test(source)
    : field.unit === 'cents' && /¢|\bcents\b/i.test(source);
}

function citeIssues(name: FieldName, field: RawField, manifest: OcrManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: ValidationIssue['code'], message: string): void => { issues.push({ code, field: name, message, citations: field.citations }); };
  if (field.citations.length === 0) add('EVIDENCE_MISSING', 'A required value has no source citation');
  for (const citation of field.citations) {
    const page = manifest.pages.find(item => item.pageNumber === citation.page);
    const block = page?.blocks.find(item => item.id === citation.blockId);
    if (page === undefined || block === undefined || !block.text.includes(citation.quote) || !sameBox(citation, block)) {
      add('CITATION_INVALID', 'The exact quotation or bounding box does not exist in its referenced OCR block');
      continue;
    }
    if (!expectedSections[name].includes(block.section) || !fieldAnchors[name].test(block.text)) {
      add('SOURCE_SECTION_INVALID', 'The citation is not from the expected field in its document section');
    }
    if (!sourceUnitMatches(name, field, block.text)) {
      add('NORMALIZATION_INVALID', 'The extracted unit is not supported by the cited source field');
    }
    if (!numericStrings(citation.quote).some(token => sameNumericValue(token, field))) {
      add('EVIDENCE_CONFLICT', 'The quoted numeric value disagrees with the extracted source value');
    }
    // A confident heading cannot substitute for confidence on the cited number itself.
    const numericTokens = block.tokens.filter(token => numericStrings(token.text).some(value => sameNumericValue(value, field)));
    if (numericTokens.length === 0 || numericTokens.some(token => token.confidence === null)) {
      add('OCR_CONFIDENCE_MISSING', 'Numeric OCR token confidence is unavailable');
    } else if (numericTokens.some(token => (token.confidence ?? 0) < DEMO_POLICY.minimumOcrConfidence)) {
      add('OCR_LOW_CONFIDENCE', 'A cited numeric OCR token is below the policy confidence threshold');
    }
  }
  return issues;
}

function repeatedEvidenceIssues(name: FieldName, field: RawField, manifest: OcrManifest): ValidationIssue[] {
  if (field.value === null) return [];
  const repeatedValues = [...field.conflictingValues];
  for (const page of manifest.pages) {
    for (const block of page.blocks) {
      if (!expectedSections[name].includes(block.section)) continue;
      const label = fieldAnchors[name].exec(block.text);
      if (label === null) continue;
      const rest = block.text.slice((label.index ?? 0) + label[0].length);
      const value = numericStrings(rest)[0];
      if (value !== undefined) repeatedValues.push(value);
    }
  }
  if (repeatedValues.some(value => !sameNumericValue(String(value), field))) {
    return [{ code: 'EVIDENCE_CONFLICT', field: name, message: 'Repeated evidence contains different values for the same field and period', citations: field.citations }];
  }
  return [];
}

function sourceSemantics(raw: RawExtraction, manifest: OcrManifest, issues: ValidationIssue[]): Pick<LoanFacts, 'debtExcludesProposedLoan' | 'cashPriceExcludesExtras' | 'fixedApr'> {
  const termsText = manifest.pages.flatMap(page => page.blocks)
    .filter(block => ['terms', 'debts', 'application'].includes(block.section))
    .map(block => block.text).join('\n');
  const debt = /existing\s+debt[^\n]*excludes\s+(?:the\s+)?proposed\s+(?:vehicle\s+)?loan/i.test(termsText);
  const price = /(?:vehicle\s+)?cash\s+price[^\n]*excludes\s+taxes,?\s+fees,?\s+(?:and\s+)?optional\s+products/i.test(termsText);
  const fixed = /fixed\s+apr\s*:/i.test(termsText);
  if (raw.debtExcludesProposedLoan === true && !debt) issues.push({ code: 'DEBT_DOUBLE_COUNTING', message: 'The exclusion of the proposed loan is not supported by source text' });
  if (raw.cashPriceExcludesExtras === true && !price) issues.push({ code: 'CASH_PRICE_AMBIGUOUS', message: 'The cash price definition is not supported by source text' });
  if (raw.fixedApr === true && !fixed) issues.push({ code: 'UNSUPPORTED_TERMS', message: 'A fixed APR is not supported by source text' });
  return {
    debtExcludesProposedLoan: raw.debtExcludesProposedLoan === true && debt ? true : raw.debtExcludesProposedLoan === false ? false : null,
    cashPriceExcludesExtras: raw.cashPriceExcludesExtras === true && price ? true : raw.cashPriceExcludesExtras === false ? false : null,
    fixedApr: raw.fixedApr === true && fixed ? true : raw.fixedApr === false ? false : null,
  };
}

/** Model text and PDF instructions remain data; only deterministic checks establish usable facts. */
export function validateEvidence(input: unknown, manifest: OcrManifest, verification?: VerificationRecord): EvidenceValidation {
  const parsed = rawExtractionSchema.safeParse(input);
  const raw = parsed.success ? parsed.data : emptyExtraction();
  const issues: ValidationIssue[] = parsed.success ? [] : [{ code: 'SCHEMA_INVALID', message: 'Structured extraction did not match the permitted schema' }];
  const normalized = Object.fromEntries(fieldNames.map(name => [name, normalizeField(name, raw.fields[name])])) as Pick<LoanFacts, FieldName>;
  const parsedVerification = verificationRecordSchema.safeParse(verification);
  const verified = parsedVerification.success && parsedVerification.data.documentHash === manifest.documentHash ? parsedVerification.data : undefined;
  for (const name of fieldNames) {
    const field = raw.fields[name];
    if (field.value === null) issues.push({ code: 'EVIDENCE_MISSING', field: name, message: 'The field is missing or ambiguous' });
    else {
      if (normalized[name] === null) {
        const periodProblem = name === 'grossMonthlyIncomeCents'
          && !['weekly', 'biweekly', 'semimonthly', 'monthly'].includes(field.period ?? '');
        issues.push({ code: periodProblem ? 'UNSUPPORTED_PERIOD' : 'NORMALIZATION_INVALID', field: name, message: 'Value, unit, or period cannot be normalized safely' });
      }
      issues.push(...citeIssues(name, field, manifest), ...repeatedEvidenceIssues(name, field, manifest));
    }
    if (verified === undefined || !verified.verifiedFields.includes(name)) issues.push({ code: 'VERIFICATION_REQUIRED', field: name, message: 'No matching independent source verification record is available' });
  }
  const incomePeriod = raw.fields.grossMonthlyIncomeCents.period;
  const periods = manifest.pages.flatMap(page => page.blocks).filter(block => block.section === 'income')
    .flatMap(block => [
      ...[...block.text.matchAll(/pay\s+period\s*:\s*(weekly|biweekly|semimonthly|monthly|annual)/gi)].map(match => match[1]?.toLowerCase()),
      ...[...block.text.matchAll(/gross\s+(weekly|biweekly|semimonthly|monthly|annual)\s+income\s*:/gi)].map(match => match[1]?.toLowerCase()),
    ]);
  if (raw.fields.grossMonthlyIncomeCents.value !== null && periods.some(period => period !== incomePeriod)) {
    issues.push({ code: 'EVIDENCE_CONFLICT', field: 'grossMonthlyIncomeCents', message: 'The extracted pay frequency conflicts with the source pay period' });
  }
  if (manifest.qualityFlags.length > 0) issues.push({ code: 'EVIDENCE_AMBIGUOUS', message: `Document quality flags: ${manifest.qualityFlags.join(', ')}` });
  const facts: LoanFacts = { ...normalized, ...sourceSemantics(raw, manifest, issues) };
  return { facts, fields: raw.fields, issues };
}
