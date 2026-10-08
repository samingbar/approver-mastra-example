import {
  fieldNames, rawExtractionSchema, type FieldName, type OcrManifest,
  type RawExtraction, type RawField,
} from '../contracts.js';

const labels: Record<FieldName, RegExp> = {
  grossMonthlyIncomeCents: /gross\s+(?:(monthly|weekly|biweekly|semimonthly|annual)\s+)?income\s*:\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
  existingMonthlyDebtCents: /existing\s+monthly\s+debt\s+payments\s*:\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
  financedAmountCents: /financed\s+amount\s*:\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
  vehicleCashPriceCents: /vehicle\s+cash\s+price\s*:\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
  proposedMonthlyPaymentCents: /proposed\s+monthly\s+payment\s*:\s*\$?([\d,]+(?:\.\d{1,2})?)/i,
  termMonths: /term\s*:\s*([\d]+)\s*months/i,
  aprBps: /fixed\s+apr\s*:\s*([\d]+(?:\.\d{1,2})?)\s*%/i,
  creditScore: /credit\s+score\s*:\s*([\d]+)/i,
};

/** Declared fixture model adapter. Its only input is actual OCR, never fixture facts. */
export function fixtureModelResponse(manifest: OcrManifest): RawExtraction {
  const fields = {} as Record<FieldName, RawField>;
  for (const name of fieldNames) {
    const matches: { value: number; period: RawField['period']; citation: RawField['citations'][number] }[] = [];
    for (const page of manifest.pages) for (const block of page.blocks) {
      const match = labels[name].exec(block.text);
      if (!match) continue;
      const value = Number((name === 'grossMonthlyIncomeCents' ? match[2] : match[1]).replaceAll(',', ''));
      const period = name === 'grossMonthlyIncomeCents'
        ? (match[1]?.toLowerCase() ?? 'unknown') as RawField['period']
        : name === 'existingMonthlyDebtCents' || name === 'proposedMonthlyPaymentCents' ? 'monthly' : null;
      matches.push({ value, period, citation: {
        page: page.pageNumber, blockId: block.id, quote: match[0], boundingBox: block.boundingBox,
      } });
    }
    const distinctValues = [...new Set(matches.map((match) => match.value))];
    fields[name] = {
      value: matches[0]?.value ?? null,
      unit: name === 'termMonths' ? 'months' : name === 'creditScore' ? 'score' : name === 'aprBps' ? 'percent' : 'USD',
      period: matches[0]?.period ?? null, citations: matches.map((match) => match.citation),
      conflictingValues: distinctValues.length > 1 ? distinctValues : [],
    };
  }
  const allText = manifest.pages.flatMap((page) => page.blocks.map((block) => block.text)).join('\n');
  return rawExtractionSchema.parse({
    fields,
    debtExcludesProposedLoan: /debt[^\n]*(?:exclude|excluding)[^\n]*proposed/i.test(allText) ? true : null,
    cashPriceExcludesExtras: /cash\s+price[^\n]*(?:exclude|excluding)[^\n]*(?:tax|fee)/i.test(allText) ? true : null,
    fixedApr: /fixed\s+apr/i.test(allText) ? true : null,
    notes: ['Fixture mode: deterministic model response assembled from actual OCR evidence.'],
  });
}
