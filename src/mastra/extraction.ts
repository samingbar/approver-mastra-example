import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { z } from 'zod';
import {
  artifactRefSchema, extractionArtifactSchema, ocrManifestSchema, rawExtractionSchema, validationIssueSchema,
  verificationRecordSchema, type ArtifactRef, type OcrManifest,
  type VerificationRecord, type ValidationIssue,
} from '../contracts.js';
import { validateEvidence } from '../evidence.js';
import { analysisInputSchema, analysisOutputSchema, type AnalysisInput } from '../integration/analysis-child-contract.js';
import { ArtifactStore, canonicalJson, hashBytes } from '../storage.js';
import { EXTRACTION_INSTRUCTIONS, PROMPT_VERSION, configuredModelId, getExtractionAgent } from './agent.js';
import { fixtureModelResponse } from './fixture-model.js';
import { configureExtractionDiagnostics } from './diagnostics.js';
import { createWorkflow, createStep } from './temporal.js';

const draftOutputSchema = z.object({ draftRef: artifactRefSchema }).strict();
const draftSchema = z.object({
  input: analysisInputSchema,
  raw: rawExtractionSchema, issues: z.array(validationIssueSchema),
  providerRequestId: z.string().nullable(),
  attempts: extractionArtifactSchema.shape.attempts,
  modelId: z.string(), promptVersion: z.string(), promptHash: z.string(),
  nativeActivityAttempt: z.number().int().positive(),
  diagnosticRefs: z.array(artifactRefSchema).default([]),
}).strict();

export function extractionKey(input: AnalysisInput): string {
  const revisionHash = hashBytes(Buffer.from(canonicalJson({
    analysisRevision: input.analysisRevision, ocrArtifactHash: input.manifestRef.sha256,
    mode: input.mode, modelId: input.mode === 'fixture' ? 'fixture-deterministic-v1' : configuredModelId(),
    promptHash: hashBytes(Buffer.from(EXTRACTION_INSTRUCTIONS)), schemaVersion: 'loan-evidence-v1',
  })));
  return `extraction/${input.documentHash}/${revisionHash}/evidence.json`;
}

async function artifactRefForKey(store: ArtifactStore, key: string): Promise<ArtifactRef> {
  const bytes = await store.getBytes(key);
  return { key, sha256: hashBytes(bytes), size: bytes.length, contentType: 'application/json' };
}

async function loadVerifiedJson(store: ArtifactStore, ref: ArtifactRef): Promise<unknown> {
  const bytes = await store.getBytes(ref.key);
  if (hashBytes(bytes) !== ref.sha256) throw ApplicationFailure.nonRetryable('Artifact hash mismatch', 'ARTIFACT_INTEGRITY');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}

async function fixtureVerification(documentHash: string): Promise<VerificationRecord | undefined> {
  const filename = process.env.FIXTURE_MANIFEST_PATH ?? `${process.cwd()}/fixtures/manifest.json`;
  const manifest = JSON.parse(await readFile(filename, 'utf8')) as { fixtures: { sha256: string; verification: unknown }[] };
  const fixture = manifest.fixtures.find((entry) => entry.sha256 === documentHash);
  return fixture ? verificationRecordSchema.parse(fixture.verification) : undefined;
}

export function relevantModelInput(manifest: OcrManifest): string {
  const financialSections = new Set(['income', 'debts', 'terms', 'bureau']);
  const financialText = /\b(?:income|salary|wages|earnings|debt|financed|cash\s+price|monthly\s+payment|loan\s+amount|principal|term|apr|annual\s+percentage\s+rate|interest\s+rate|credit\s+score|pay\s+(?:period|frequency)|taxes|fees|optional\s+products)\b/i;
  const financialLabel = /\b(?:gross\s+(?:(?:monthly|weekly|biweekly|semimonthly|annual)\s+)?income|existing\s+(?:monthly\s+)?debt(?:\s+payments)?|financed\s+amount|(?:vehicle\s+)?cash\s+price|proposed\s+(?:monthly\s+)?payment|loan\s+amount|principal|term|(?:fixed\s+)?apr|annual\s+percentage\s+rate|interest\s+rate|credit\s+score|salary|wages|earnings|pay\s+(?:period|frequency))\s*[:=]/i;
  const identityLabel = /\b(?:applicant|borrower|co[-\s]?applicant|name|address|ssn|social\s+security|date\s+of\s+birth|dob|phone|telephone|email|e-mail|driver'?s?\s+licen[cs]e|account\s+(?:number|no))\b/i;
  const identityValue = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b\d{3}[- ]\d{2}[- ]\d{4}\b|\(\d{3}\)\s*\d{3}[- .]\d{4}|\b\d{3}[- .]\d{3}[- .]\d{4}\b|\b\d{1,6}\s+[A-Z0-9 .'\-]{2,48}\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|court|ct)\b/i;
  // Keep original text and coordinates for exact citation verification. Drop a
  // whole mixed identity/evidence block instead of redacting its source quote.
  const selected = manifest.pages.flatMap((page) => page.blocks
    .filter((block) => !identityLabel.test(block.text) && !identityValue.test(block.text))
    .filter((block) => financialLabel.test(block.text)
      || (financialSections.has(block.section) && financialText.test(block.text)))
    .map((block) => ({ page: page.pageNumber, id: block.id, text: block.text,
      boundingBox: block.boundingBox, section: block.section, confidence: block.confidence })));
  return canonicalJson(selected);
}

export async function inferFacts(input: AnalysisInput, manifest: OcrManifest, signal: AbortSignal) {
  const budget = Number(process.env.MODEL_INPUT_MAX_CHARACTERS ?? '32000');
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 128_000) {
    throw ApplicationFailure.nonRetryable('Model input budget must be a positive integer at most 128000 characters', 'AUTH_CONFIGURATION');
  }
  const modelInput = relevantModelInput(manifest);
  const modelId = input.mode === 'fixture' ? 'fixture-deterministic-v1' : configuredModelId();
  if (modelInput.length > budget) {
    const raw = fixtureModelResponse({ ...manifest, pages: [] });
    return { raw, modelId, providerRequestId: null, attempts: [],
      issues: [{ code: 'INPUT_BUDGET_EXCEEDED' as const, message: `OCR evidence exceeds the ${budget} character model budget; no evidence was truncated.` }] };
  }
  const context = Context.current();
  const failAttempts = Number(process.env.EXTRACTION_FAIL_ATTEMPTS ?? '0');
  if (input.mode === 'fixture' && context.info.attempt <= failAttempts) {
    if (process.env.EXTRACTION_FAILURE_CODE === 'AUTH_CONFIGURATION') {
      throw ApplicationFailure.nonRetryable('Extraction provider configuration missing', 'AUTH_CONFIGURATION');
    }
    throw ApplicationFailure.retryable('Injected fixture provider failure', process.env.EXTRACTION_FAILURE_CODE ?? 'PROVIDER_429');
  }
  if (input.mode === 'fixture') return {
    raw: fixtureModelResponse(manifest), modelId, providerRequestId: null,
    attempts: [{ kind: 'inference' as const, succeeded: true }], issues: [],
  };
  if (!process.env.MODEL_API_KEY && !process.env.OPENAI_API_KEY && configuredModelId().startsWith('openai/')) {
    throw ApplicationFailure.nonRetryable('Set MODEL_API_KEY securely in the environment for live extraction', 'AUTH_CONFIGURATION');
  }
  const attempts: z.infer<typeof extractionArtifactSchema.shape.attempts> = [];
  let repairNote = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await getExtractionAgent().generate(`${modelInput}${repairNote}`, {
        structuredOutput: { schema: rawExtractionSchema, errorStrategy: 'strict' },
        maxSteps: 1, abortSignal: signal,
        modelSettings: { maxRetries: 0, timeout: { totalMs: 55_000, stepMs: 50_000 } },
        tracingOptions: {
          rootSpanName: 'loan-evidence-extraction', hideInput: true, hideOutput: true,
          metadata: { applicationId: input.applicationId, analysisRevision: input.analysisRevision,
            workflowId: context.info.workflowExecution?.workflowId,
            workflowRunId: context.info.workflowExecution?.runId },
        },
      });
      const parsed = rawExtractionSchema.safeParse(response.object);
      attempts.push({ kind: attempt === 0 ? 'inference' : 'schema_repair', succeeded: parsed.success,
        ...(!parsed.success ? { errorCode: 'SCHEMA_INVALID' } : {}) });
      if (parsed.success) return { raw: parsed.data, modelId, providerRequestId: response.response.id ?? null, attempts, issues: [] };
    } catch (error) {
      // Schema errors allow one bounded repair. HTTP/deadline failures belong to
      // Temporal retries; do not turn them into guessed evidence or policy FAIL.
      if (context.cancellationSignal.aborted || error instanceof CancelledFailure) {
        throw new CancelledFailure('Extraction canceled');
      }
      const structured = (typeof error === 'object' && error !== null ? error : {}) as { name?: string; id?: string; statusCode?: number };
      if (structured.statusCode === 401 || structured.statusCode === 403) {
        throw ApplicationFailure.nonRetryable('Extraction provider authentication failed', 'AUTH_CONFIGURATION');
      }
      if (!['AI_NoObjectGeneratedError', 'AI_JSONParseError', 'AI_TypeValidationError', 'ZodError'].includes(structured.name ?? '')
          && !['STRUCTURED_OUTPUT_OBJECT_UNDEFINED', 'STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED', 'STRUCTURED_OUTPUT_TRUNCATED'].includes(structured.id ?? '')) {
        if (structured.statusCode === 400 || structured.statusCode === 404) {
          throw ApplicationFailure.nonRetryable('Extraction provider model configuration was rejected', 'AUTH_CONFIGURATION');
        }
        const code = structured.statusCode === 429 ? 'PROVIDER_429'
          : signal.aborted || /timeout|abort/i.test(structured.name ?? '') ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE';
        // Never propagate provider request bodies, document text, or raw causes
        // into Temporal failure payloads or worker logs.
        throw ApplicationFailure.retryable('Extraction provider request failed', code);
      }
      attempts.push({ kind: attempt === 0 ? 'inference' : 'schema_repair', succeeded: false, errorCode: 'SCHEMA_INVALID' });
    }
    repairNote = '\nThe prior structured response failed schema validation. Emit only the exact schema, with null for unsupported fields.';
  }
  // A malformed model result remains evidence requiring human review.
  return { raw: fixtureModelResponse({ ...manifest, pages: [] }), modelId,
    providerRequestId: null, attempts,
    issues: [{ code: 'SCHEMA_INVALID' as const, message: 'Structured inference failed validation after one bounded schema repair.' }] };
}

export const extractRelevantFacts = createStep({
  id: 'extractRelevantFacts', inputSchema: analysisInputSchema, outputSchema: draftOutputSchema,
  execute: async ({ inputData, mastra: runtimeMastra }) => {
    const input = analysisInputSchema.parse(inputData);
    const store = new ArtifactStore();
    const key = extractionKey(input).replace('evidence.json', 'draft.json');
    try {
      if (await store.exists(key)) return { draftRef: await artifactRefForKey(store, key) };
      const manifest = ocrManifestSchema.parse(await loadVerifiedJson(store, input.manifestRef));
      if (manifest.documentHash !== input.documentHash) throw ApplicationFailure.nonRetryable('OCR document hash mismatch', 'ARTIFACT_INTEGRITY');
      const diagnostics = input.mode === 'live' && runtimeMastra ? configureExtractionDiagnostics(runtimeMastra) : undefined;
      if (input.mode === 'live') runtimeMastra?.addAgent(getExtractionAgent(), 'loan-evidence-extractor');
      const context = Context.current();
      const heartbeat = setInterval(() => context.heartbeat({ artifactKey: key, stage: 'inference' }), 5_000);
      try {
        context.heartbeat({ artifactKey: key, stage: 'inference' });
        const signal = AbortSignal.any([context.cancellationSignal, AbortSignal.timeout(60_000)]);
        let inferred: Awaited<ReturnType<typeof inferFacts>>;
        try { inferred = await inferFacts(input, manifest, signal); }
        finally { await diagnostics?.observability.flush(); }
        return { draftRef: await store.putJsonImmutable(key, draftSchema.parse({
          input, ...inferred, promptVersion: PROMPT_VERSION,
          promptHash: hashBytes(Buffer.from(EXTRACTION_INSTRUCTIONS)),
          nativeActivityAttempt: context.info.attempt,
          diagnosticRefs: diagnostics?.exporter.takeApplicationRefs(input.applicationId) ?? [],
        })) };
      } finally { clearInterval(heartbeat); }
    } finally { store.close(); }
  },
});

export const validateAndSaveEvidence = createStep({
  id: 'validateAndSaveEvidence', inputSchema: draftOutputSchema, outputSchema: analysisOutputSchema,
  execute: async ({ inputData }) => {
    const store = new ArtifactStore();
    try {
      const draftRef = draftOutputSchema.parse(inputData).draftRef;
      const draft = draftSchema.parse(await loadVerifiedJson(store, draftRef));
      // The completed first step pins model/prompt/OCR versions in this stable key.
      const key = draftRef.key.replace(/draft\.json$/, 'evidence.json');
      if (await store.exists(key)) return { extractionRef: await artifactRefForKey(store, key) };
      const context = Context.current();
      const heartbeat = setInterval(() => context.heartbeat({ artifactKey: key, stage: 'validation' }), 5_000);
      try {
        context.heartbeat({ artifactKey: key, stage: 'validation' });
        await delay(draft.input.mode === 'fixture' ? Number(process.env.EXTRACTION_VALIDATE_DELAY_MS ?? '0') : 0, undefined,
          { signal: AbortSignal.any([context.cancellationSignal, AbortSignal.timeout(60_000)]) });
        const manifest = ocrManifestSchema.parse(await loadVerifiedJson(store, draft.input.manifestRef));
        const verification = draft.input.mode === 'fixture' ? await fixtureVerification(draft.input.documentHash) : undefined;
        const result = validateEvidence(draft.raw, manifest, verification);
        result.issues.push(...draft.issues as ValidationIssue[]);
        const artifact = extractionArtifactSchema.parse({
          schemaVersion: 'loan-evidence-v1', documentHash: draft.input.documentHash,
          ocrArtifactHash: draft.input.manifestRef.sha256, ocrVersion: manifest.ocrVersion,
          analysisRevision: draft.input.analysisRevision, promptVersion: draft.promptVersion,
          promptHash: draft.promptHash, modelId: draft.modelId,
          mode: draft.input.mode, providerRequestId: draft.providerRequestId,
          attempts: draft.attempts, result, verificationRecord: verification,
          nativeActivityAttempts: {
            extractRelevantFacts: draft.nativeActivityAttempt,
            validateAndSaveEvidence: context.info.attempt,
          },
          diagnosticRefs: draft.diagnosticRefs,
        });
        return { extractionRef: await store.putJsonImmutable(key, artifact) };
      } finally { clearInterval(heartbeat); }
    } finally { store.close(); }
  },
});

export const extractApplicationWorkflow = createWorkflow({
  id: 'extract-application', inputSchema: analysisInputSchema, outputSchema: analysisOutputSchema,
}).then(extractRelevantFacts).then(validateAndSaveEvidence).commit();
