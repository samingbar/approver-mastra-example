import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { emptyExtraction } from '../src/evidence.js';
import { ocrManifestSchema } from '../src/contracts.js';
import type { AnalysisInput } from '../src/integration/analysis-child-contract.js';

const generate = vi.hoisted(() => vi.fn());
vi.mock('../src/mastra/agent.js', () => ({
  EXTRACTION_INSTRUCTIONS: 'Test bounded extraction', PROMPT_VERSION: 'test',
  configuredModelId: () => 'openai/test-model',
  getExtractionAgent: () => ({ generate }),
}));
const { inferFacts, relevantModelInput } = await import('../src/mastra/extraction.js');
const hash = 'a'.repeat(64);
const input: AnalysisInput = {
  applicationId: 'synthetic-test', documentHash: hash,
  manifestRef: { key: 'test/ocr.json', sha256: hash, contentType: 'application/json', size: 1 },
  mode: 'live', analysisRevision: 'test-v1',
};
const manifest = ocrManifestSchema.parse({
  documentHash: hash, ocrVersion: 'test', engineVersion: 'test', qualityFlags: [],
  pages: [{ pageNumber: 1, width: 100, height: 100, imageRef: input.manifestRef,
    pageHash: hash, engineVersion: 'test', blocks: [] }],
});
afterEach(() => { vi.unstubAllEnvs(); generate.mockReset(); });

function invoke(): ReturnType<typeof inferFacts> {
  vi.stubEnv('MODEL_API_KEY', 'test-only-mocked-credential');
  return new MockActivityEnvironment().run(inferFacts, input, manifest, new AbortController().signal) as ReturnType<typeof inferFacts>;
}

describe('bounded structured inference', () => {
  it('sends only financial evidence and drops unknown narrative, inline identities and unused OCR token text', async () => {
    const boundingBox = { x: 1, y: 2, width: 30, height: 10 };
    const source = ocrManifestSchema.parse({ ...manifest, pages: [{ ...manifest.pages[0], blocks: [
      { id: 'income', section: 'income', text: 'Gross monthly income: $8,500.00', boundingBox,
        confidence: 99, tokens: [{ text: 'private unused token', confidence: 99 }] },
      { id: 'unknown-note', section: 'unknown', text: 'private unlabeled packet note', boundingBox,
        confidence: 99, tokens: [] },
      { id: 'mixed-applicant', section: 'income', text: 'Gross monthly income: $9,000.00; Applicant Jane Doe', boundingBox,
        confidence: 99, tokens: [] },
      { id: 'mixed-email', section: 'terms', text: 'Fixed APR: 6.50%; jane@example.test', boundingBox,
        confidence: 99, tokens: [] },
      { id: 'apr', section: 'unknown', text: 'Fixed APR: 6.50%', boundingBox,
        confidence: 99, tokens: [] },
    ] }] });
    const encoded = relevantModelInput(source);
    const selected = JSON.parse(encoded) as { id: string; text: string; boundingBox: unknown; page: number }[];
    expect(selected.map((block) => block.id)).toEqual(['income', 'apr']);
    expect(selected[0]).toMatchObject({ page: 1, text: source.pages[0].blocks[0].text, boundingBox });
    expect(encoded).not.toContain('private');
    expect(encoded).not.toContain('Jane');
    expect(encoded).not.toContain('example.test');
    expect(encoded).not.toContain('tokens');
    vi.stubEnv('MODEL_API_KEY', 'test-only-mocked-credential');
    generate.mockResolvedValueOnce({ object: emptyExtraction(), response: { id: 'minimized-request' } });
    await new MockActivityEnvironment().run(inferFacts, input, source, new AbortController().signal);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0]).toBe(encoded);
  });

  it('records a single schema repair and accepts only the validated repair output', async () => {
    generate.mockRejectedValueOnce(Object.assign(new Error('malformed response'), { name: 'AI_NoObjectGeneratedError' }));
    generate.mockResolvedValueOnce({ object: emptyExtraction(), response: { id: 'synthetic-request-id' } });
    const result = await invoke();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.attempts).toEqual([
      { kind: 'inference', succeeded: false, errorCode: 'SCHEMA_INVALID' },
      { kind: 'schema_repair', succeeded: true },
    ]);
    expect(result.providerRequestId).toBe('synthetic-request-id');
  });

  it('leaves malformed evidence null and marks review after both attempts fail', async () => {
    generate.mockRejectedValue(Object.assign(new Error('malformed response'), { name: 'AI_NoObjectGeneratedError' }));
    const result = await invoke();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.raw.fields.creditScore.value).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain('SCHEMA_INVALID');
  });

  it('propagates provider throttling to Temporal without performing a schema repair', async () => {
    const throttled = Object.assign(new Error('provider throttled'), { statusCode: 429 });
    generate.mockRejectedValue(throttled);
    const result = await invoke().catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ApplicationFailure);
    expect((result as ApplicationFailure).type).toBe('PROVIDER_429');
    expect((result as ApplicationFailure).cause).toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('classifies authentication as nonretryable technical configuration failure', async () => {
    generate.mockRejectedValue(Object.assign(new Error('unauthorized'), { statusCode: 401 }));
    const result = await invoke().catch((error: unknown) => error);
    expect(result).toBeInstanceOf(ApplicationFailure);
    expect((result as ApplicationFailure).nonRetryable).toBe(true);
    expect((result as ApplicationFailure).type).toBe('AUTH_CONFIGURATION');
  });

  it('does no inference when the explicit input budget would be exceeded', async () => {
    vi.stubEnv('MODEL_INPUT_MAX_CHARACTERS', '1');
    const result = await invoke();
    expect(generate).not.toHaveBeenCalled();
    expect(result.issues.map((issue) => issue.code)).toContain('INPUT_BUDGET_EXCEEDED');
  });

  it('rejects malformed input-budget configuration before any inference', async () => {
    vi.stubEnv('MODEL_INPUT_MAX_CHARACTERS', 'NaN');
    const result = await invoke().catch((error: unknown) => error);
    expect((result as ApplicationFailure).type).toBe('AUTH_CONFIGURATION');
    expect((result as ApplicationFailure).nonRetryable).toBe(true);
    expect(generate).not.toHaveBeenCalled();
  });

  it('sanitizes provider failures without persisting response bodies or causes', async () => {
    generate.mockRejectedValue(Object.assign(new Error('private document in response body'), { name: 'MastraTimeoutError' }));
    const result = await invoke().catch((error: unknown) => error);
    expect((result as ApplicationFailure).type).toBe('PROVIDER_TIMEOUT');
    expect((result as ApplicationFailure).message).not.toContain('private');
    expect((result as ApplicationFailure).cause).toBeUndefined();
  });

  it('preserves cooperative cancellation rather than treating it as a provider retry', async () => {
    vi.stubEnv('MODEL_API_KEY', 'test-only-mocked-credential');
    const environment = new MockActivityEnvironment();
    generate.mockImplementation(async () => {
      environment.cancel();
      throw new Error('canceled provider body');
    });
    const result = await environment.run(inferFacts, input, manifest, new AbortController().signal).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(CancelledFailure);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
