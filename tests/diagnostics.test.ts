import { describe, expect, it, vi } from 'vitest';
import { Mastra } from '@mastra/core/mastra';
import { DualLogger, noopLogger } from '@mastra/core/logger';
import { SpanType, TracingEventType, type TracingEvent } from '@mastra/core/observability';
import { configureExtractionDiagnostics, ImmutableModelDiagnosticExporter } from '../src/mastra/diagnostics.js';
import { canonicalJson, hashBytes } from '../src/storage.js';
import type { ArtifactRef } from '../src/contracts.js';
import { mastra as extractionRuntime } from '../src/mastra/index.js';
import { getExtractionAgent } from '../src/mastra/agent.js';

class CapturingStore {
  readonly records = new Map<string, unknown>();
  async putJsonImmutable(key: string, value: unknown): Promise<ArtifactRef> {
    this.records.set(key, value);
    const bytes = Buffer.from(canonicalJson(value));
    return { key, sha256: hashBytes(bytes), size: bytes.length, contentType: 'application/json' };
  }
  close() {}
}

describe('privacy-safe Mastra model diagnostics', () => {
  it('suppresses raw SDK provider error logging on the real extraction runtime and lazy agent', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const agent = getExtractionAgent();
      extractionRuntime.addAgent(agent, 'loan-evidence-extractor');
      const logger = extractionRuntime.getLogger();
      expect(logger instanceof DualLogger ? logger.baseLogger : logger).toBe(noopLogger);
      expect(agent).toHaveProperty('logger', logger);
      extractionRuntime.getLogger().error('private provider response body', { error: new Error('private request body') });
      expect(consoleError).not.toHaveBeenCalled();
    } finally { consoleError.mockRestore(); }
  });

  it('omits document text, model reasoning, credentials and arbitrary metadata from exported spans', async () => {
    const store = new CapturingStore();
    const exporter = new ImmutableModelDiagnosticExporter(store);
    const event: TracingEvent = {
      type: TracingEventType.SPAN_ENDED,
      exportedSpan: {
        id: '1111111111111111', traceId: '22222222222222222222222222222222',
        name: 'identity must not be exported', type: SpanType.MODEL_GENERATION,
        startTime: new Date('2026-10-06T00:00:00Z'), endTime: new Date('2026-10-06T00:00:01Z'),
        isEvent: false, isRootSpan: true,
        input: 'private applicant document', output: 'hidden model reasoning',
        requestContext: { apiKey: 'private credential' },
        metadata: { applicationId: 'opaque-application', workflowId: 'opaque-workflow',
          workflowRunId: 'opaque-run', analysisRevision: 'pinned-analysis', apiKey: 'private credential', applicantName: 'private name' },
        attributes: { model: 'test-model', provider: 'test-provider', usage: { inputTokens: 100, outputTokens: 20 },
          parameters: { headers: { Authorization: 'private credential' } } },
        errorInfo: { message: 'private provider body', stack: 'private stack' },
      },
    };
    await exporter.exportTracingEvent(event);
    await exporter.exportTracingEvent(event);
    await exporter.flush();
    expect(store.records.size).toBe(1);
    const encoded = JSON.stringify([...store.records.values()]);
    expect(encoded).not.toContain('private');
    expect(encoded).not.toContain('hidden model reasoning');
    expect(encoded).not.toContain('Authorization');
    expect([...store.records.values()][0]).toMatchObject({
      metadata: { applicationId: 'opaque-application', workflowId: 'opaque-workflow', workflowRunId: 'opaque-run' },
      model: 'test-model', inputTokens: 100, outputTokens: 20, durationMs: 1000, failed: true,
    });
    expect(exporter.takeApplicationRefs('opaque-application')).toHaveLength(1);
    await exporter.shutdown();
  });

  it('bootstraps the actual Mastra observability bus and persists real SDK span lifecycle events', async () => {
    const store = new CapturingStore();
    const exporter = new ImmutableModelDiagnosticExporter(store);
    const mastra = new Mastra({});
    const diagnostics = configureExtractionDiagnostics(mastra, exporter);
    const instance = diagnostics.observability.getDefaultInstance()!;
    const span = instance.startSpan({
      type: SpanType.AGENT_RUN, name: 'loan-evidence-extraction',
      metadata: { applicationId: 'actual-mastra-span', workflowId: 'native-child', workflowRunId: 'run-1' },
      input: 'private evidence input',
    });
    span.end({ output: { text: 'private structured output' } });
    await diagnostics.observability.flush();
    await exporter.flush();
    const records = [...store.records.values()];
    expect(records.length).toBeGreaterThanOrEqual(2);
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'span_started' }), expect.objectContaining({ event: 'span_ended' })]));
    expect(JSON.stringify(records)).not.toContain('private');
    expect(exporter.takeApplicationRefs('actual-mastra-span').length).toBeGreaterThanOrEqual(2);
    await diagnostics.observability.shutdown();
  });
});
