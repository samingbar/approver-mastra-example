import { z } from 'zod';

export const reasonCodeSchema = z.enum([
  'SCHEMA_INVALID', 'EVIDENCE_MISSING', 'EVIDENCE_AMBIGUOUS', 'EVIDENCE_CONFLICT',
  'CITATION_INVALID', 'SOURCE_SECTION_INVALID', 'NORMALIZATION_INVALID',
  'OCR_LOW_CONFIDENCE', 'OCR_CONFIDENCE_MISSING', 'VERIFICATION_REQUIRED',
  'UNSUPPORTED_PERIOD', 'INPUT_BUDGET_EXCEEDED', 'DOMAIN_INVALID',
  'DEBT_DOUBLE_COUNTING', 'CASH_PRICE_AMBIGUOUS', 'UNSUPPORTED_TERMS',
  'PAYMENT_MISMATCH', 'CREDIT_BELOW_MINIMUM', 'CREDIT_BORDERLINE',
  'DTI_ABOVE_MAXIMUM', 'DTI_BORDERLINE', 'LTV_ABOVE_MAXIMUM', 'LTV_BORDERLINE',
]);
export type ReasonCode = z.infer<typeof reasonCodeSchema>;

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const artifactRefSchema = z.object({
  key: z.string().min(1), sha256: sha256Schema,
  contentType: z.string().min(1), size: z.number().int().nonnegative(),
}).strict();
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const boundingBoxSchema = z.object({
  x: z.number().nonnegative(), y: z.number().nonnegative(),
  width: z.number().positive(), height: z.number().positive(),
}).strict();
export type BoundingBox = z.infer<typeof boundingBoxSchema>;

export const citationSchema = z.object({
  page: z.number().int().positive(), blockId: z.string().min(1),
  quote: z.string().min(1), boundingBox: boundingBoxSchema,
}).strict();
export type Citation = z.infer<typeof citationSchema>;

export const fieldNames = [
  'grossMonthlyIncomeCents', 'existingMonthlyDebtCents', 'financedAmountCents',
  'vehicleCashPriceCents', 'proposedMonthlyPaymentCents', 'termMonths', 'aprBps', 'creditScore',
] as const;
export const fieldNameSchema = z.enum(fieldNames);
export type FieldName = z.infer<typeof fieldNameSchema>;

// Identity and protected attributes deliberately have no place in these contracts.
const integerOrNull = z.number().int().safe().nullable();
export const loanFactsSchema = z.object({
  grossMonthlyIncomeCents: integerOrNull, existingMonthlyDebtCents: integerOrNull,
  financedAmountCents: integerOrNull, vehicleCashPriceCents: integerOrNull,
  proposedMonthlyPaymentCents: integerOrNull, termMonths: integerOrNull,
  aprBps: integerOrNull, creditScore: integerOrNull,
  debtExcludesProposedLoan: z.boolean().nullable(),
  cashPriceExcludesExtras: z.boolean().nullable(), fixedApr: z.boolean().nullable(),
}).strict();
export type LoanFacts = z.infer<typeof loanFactsSchema>;

export const validationIssueSchema = z.object({
  code: reasonCodeSchema, field: fieldNameSchema.optional(),
  message: z.string(), citations: z.array(citationSchema).optional(),
}).strict();
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

export const sourcePeriodSchema = z.enum([
  'weekly', 'biweekly', 'semimonthly', 'monthly', 'annual', 'unknown',
]);
export type SourcePeriod = z.infer<typeof sourcePeriodSchema>;
export const rawFieldSchema = z.object({
  value: z.union([z.number().finite(), z.string().max(200)]).nullable(),
  unit: z.enum(['USD', 'cents', 'percent', 'basis_points', 'months', 'score']).nullable(),
  period: sourcePeriodSchema.nullable(), citations: z.array(citationSchema).max(50),
  conflictingValues: z.array(z.union([z.number().finite(), z.string().max(200)])).max(20).default([]),
}).strict();
export type RawField = z.infer<typeof rawFieldSchema>;

export const rawExtractionSchema = z.object({
  fields: z.object({
    grossMonthlyIncomeCents: rawFieldSchema, existingMonthlyDebtCents: rawFieldSchema,
    financedAmountCents: rawFieldSchema, vehicleCashPriceCents: rawFieldSchema,
    proposedMonthlyPaymentCents: rawFieldSchema, termMonths: rawFieldSchema,
    aprBps: rawFieldSchema, creditScore: rawFieldSchema,
  }).strict(),
  debtExcludesProposedLoan: z.boolean().nullable(),
  cashPriceExcludesExtras: z.boolean().nullable(), fixedApr: z.boolean().nullable(),
  notes: z.array(z.string().max(2000)).max(20).default([]),
}).strict();
export type RawExtraction = z.infer<typeof rawExtractionSchema>;

export const sectionSchema = z.enum(['application', 'terms', 'income', 'debts', 'bureau', 'unknown']);
export type DocumentSection = z.infer<typeof sectionSchema>;
export const ocrTokenSchema = z.object({
  text: z.string(), confidence: z.number().min(0).max(100).nullable(),
  boundingBox: boundingBoxSchema.optional(),
}).strict();
export const ocrBlockSchema = z.object({
  id: z.string().min(1), text: z.string(), boundingBox: boundingBoxSchema,
  confidence: z.number().min(0).max(100).nullable(), tokens: z.array(ocrTokenSchema),
  section: sectionSchema,
}).strict();
export type OcrBlock = z.infer<typeof ocrBlockSchema>;
export const ocrPageSchema = z.object({
  pageNumber: z.number().int().positive(), width: z.number().positive(), height: z.number().positive(),
  imageRef: artifactRefSchema, pageHash: sha256Schema, blocks: z.array(ocrBlockSchema), engineVersion: z.string(),
}).strict();
export type OcrPage = z.infer<typeof ocrPageSchema>;
export const ocrManifestSchema = z.object({
  documentHash: sha256Schema, ocrVersion: z.string().min(1), engineVersion: z.string(),
  pages: z.array(ocrPageSchema).min(1).max(25), qualityFlags: z.array(z.string()),
}).strict();
export type OcrManifest = z.infer<typeof ocrManifestSchema>;

const verificationBase = z.object({
  documentHash: sha256Schema,
  verifiedFields: z.array(fieldNameSchema),
  recordId: z.string().min(1),
});
export const verificationRecordSchema = z.discriminatedUnion('source', [
  verificationBase.extend({ source: z.literal('synthetic-fixture') }).strict(),
  verificationBase.extend({
    source: z.literal('reviewer-attestation'), reviewerId: z.string().trim().min(1), note: z.string().trim().min(1),
  }).strict(),
]);
export type VerificationRecord = z.infer<typeof verificationRecordSchema>;

export const evidenceValidationSchema = z.object({
  facts: loanFactsSchema, issues: z.array(validationIssueSchema),
  fields: rawExtractionSchema.shape.fields,
}).strict();
export type EvidenceValidation = z.infer<typeof evidenceValidationSchema>;

export const extractionArtifactSchema = z.object({
  schemaVersion: z.literal('loan-evidence-v1'), documentHash: sha256Schema,
  ocrArtifactHash: sha256Schema, ocrVersion: z.string(), analysisRevision: z.string(),
  promptVersion: z.string(), promptHash: sha256Schema, modelId: z.string(),
  mode: z.enum(['fixture', 'live']), providerRequestId: z.string().nullable(),
  attempts: z.array(z.object({
    kind: z.enum(['inference', 'schema_repair']), succeeded: z.boolean(),
    errorCode: z.string().optional(),
  }).strict()).max(2),
  nativeActivityAttempts: z.object({
    extractRelevantFacts: z.number().int().positive(),
    validateAndSaveEvidence: z.number().int().positive(),
  }).strict().optional(),
  diagnosticRefs: z.array(artifactRefSchema).optional(),
  verificationRecord: verificationRecordSchema.optional(),
  result: evidenceValidationSchema,
}).strict();
export type ExtractionArtifact = z.infer<typeof extractionArtifactSchema>;

export const policySnapshotSchema = z.object({
  version: z.literal('demo-auto-loan-v1'), hash: sha256Schema,
  credit: z.object({ min: z.number(), max: z.number(), passMin: z.number(), reviewMin: z.number() }).strict(),
  dti: z.object({ passBps: z.number(), reviewMaxBps: z.number() }).strict(),
  ltv: z.object({ passBps: z.number(), reviewMaxBps: z.number() }).strict(),
  terms: z.object({ minMonths: z.number(), maxMonths: z.number(), maxAprBps: z.number(), paymentToleranceCents: z.number() }).strict(),
  minimumOcrConfidence: z.number(),
}).strict();
export type PolicySnapshot = z.infer<typeof policySnapshotSchema>;

export const ruleResultSchema = z.object({
  id: z.enum(['evidence', 'terms', 'credit', 'dti', 'ltv']),
  band: z.enum(['PASS', 'REVIEW', 'FAIL', 'NOT_EVALUATED']),
  reasonCodes: z.array(reasonCodeSchema),
  value: z.number().optional(), numerator: z.number().optional(), denominator: z.number().optional(),
  thresholds: z.record(z.string(), z.number()),
}).strict();
export type RuleResult = z.infer<typeof ruleResultSchema>;
export const policyDecisionSchema = z.object({
  outcome: z.enum(['PASS', 'FAIL', 'REVIEW']), reasonCodes: z.array(reasonCodeSchema),
  rules: z.array(ruleResultSchema), policyVersion: z.string(), policyHash: sha256Schema,
  educationalSimulation: z.literal(true),
}).strict();
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const applicationStatusSchema = z.enum([
  'UPLOADED', 'OCR', 'EXTRACTING', 'EVALUATING', 'REVIEW', 'SAVING',
  'AUDIT_PENDING', 'PASS', 'FAIL', 'NEEDS_DOCUMENTS', 'INPUT_ERROR', 'PROCESSING_ERROR', 'CANCELLED',
]);
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;

export const workflowIdentitySchema = z.object({ workflowId: z.string(), runId: z.string() }).strict();
export type WorkflowIdentity = z.infer<typeof workflowIdentitySchema>;
