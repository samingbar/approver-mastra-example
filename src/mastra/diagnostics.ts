import { DefaultObservabilityInstance, Observability } from '@mastra/observability';
import type { Mastra } from '@mastra/core/mastra';
import { SpanType, type ObservabilityExporter, type TracingEvent } from '@mastra/core/observability';
import type { ArtifactRef } from '../contracts.js';
import { ArtifactStore, canonicalJson, hashBytes } from '../storage.js';

interface DiagnosticStore {
  putJsonImmutable(key: string, value: unknown): Promise<ArtifactRef>;
  close(): void;
}
const correlationKeys = ['applicationId', 'analysisRevision', 'workflowId', 'workflowRunId'] as const;

function safeMetadata(input: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of correlationKeys) if (typeof input?.[key] === 'string') result[key] = input[key] as string;
  return result;
}
function safeId(id: string): string {
  return /^[a-f0-9]{8,64}$/i.test(id) ? id : hashBytes(Buffer.from(id));
}

/** Persist only explicitly permitted observables; inputs, outputs and reasoning never enter this exporter. */
export class ImmutableModelDiagnosticExporter implements ObservabilityExporter {
  readonly name = 'immutable-model-diagnostics';
  private readonly pending = new Set<Promise<void>>();
  private readonly traceMetadata = new Map<string, Record<string, string>>();
  private readonly applicationRefs = new Map<string, ArtifactRef[]>();

  constructor(private readonly store: DiagnosticStore = new ArtifactStore()) {}

  exportTracingEvent(event: TracingEvent): Promise<void> {
    const task = this.persist(event);
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task)).catch(() => undefined);
    return task;
  }

  private async persist(event: TracingEvent): Promise<void> {
    const span = event.exportedSpan;
    const metadata = { ...this.traceMetadata.get(span.traceId), ...safeMetadata(span.metadata) };
    if (Object.keys(metadata).length) {
      this.traceMetadata.set(span.traceId, metadata);
      // Correlation state is bounded; all applications also retain artifact metadata.
      if (this.traceMetadata.size > 256) this.traceMetadata.delete(this.traceMetadata.keys().next().value!);
    }
    const attributes = span.attributes as Record<string, unknown> | undefined;
    const usage = attributes?.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined;
    const start = span.startTime.toISOString();
    const end = span.endTime?.toISOString();
    const payload = {
      schemaVersion: 'model-diagnostic-v1', event: event.type,
      traceId: span.traceId, spanId: span.id, parentSpanId: span.parentSpanId,
      type: span.type, startTime: start, endTime: end,
      durationMs: span.endTime ? Math.max(0, span.endTime.getTime() - span.startTime.getTime()) : undefined,
      metadata, failed: !!span.errorInfo,
      model: typeof attributes?.model === 'string' ? attributes.model : undefined,
      provider: typeof attributes?.provider === 'string' ? attributes.provider : undefined,
      inputTokens: typeof usage?.inputTokens === 'number' ? usage.inputTokens : undefined,
      outputTokens: typeof usage?.outputTokens === 'number' ? usage.outputTokens : undefined,
      educationalSimulation: true,
    };
    const contentHash = hashBytes(Buffer.from(canonicalJson(payload)));
    const applicationPart = hashBytes(Buffer.from(metadata.applicationId ?? 'uncorrelated'));
    const key = `diagnostics/${applicationPart}/${safeId(span.traceId)}/${safeId(span.id)}/${event.type}/${contentHash}.json`;
    const ref = await this.store.putJsonImmutable(key, payload);
    if (metadata.applicationId) {
      const refs = this.applicationRefs.get(metadata.applicationId) ?? [];
      if (!refs.some((previous) => previous.key === ref.key)) refs.push(ref);
      this.applicationRefs.set(metadata.applicationId, refs);
      if (this.applicationRefs.size > 256) this.applicationRefs.delete(this.applicationRefs.keys().next().value!);
    }
  }

  takeApplicationRefs(applicationId: string): ArtifactRef[] {
    const refs = this.applicationRefs.get(applicationId) ?? [];
    this.applicationRefs.delete(applicationId);
    return refs;
  }

  async flush(): Promise<void> { await Promise.all([...this.pending]); }
  async shutdown(): Promise<void> { await this.flush(); this.store.close(); }
}

const configured = new WeakMap<Mastra, {
  observability: Observability; exporter: ImmutableModelDiagnosticExporter;
}>();

/** Called only inside a Node activity so the generated workflow stays replay-safe. */
export function configureExtractionDiagnostics(runtimeMastra: Mastra, suppliedExporter?: ImmutableModelDiagnosticExporter) {
  const existing = configured.get(runtimeMastra);
  if (existing) return existing;
  const exporter = suppliedExporter ?? new ImmutableModelDiagnosticExporter();
  const observability = new Observability({ default: { enabled: false } });
  const instance = new DefaultObservabilityInstance({
    name: 'default', serviceName: 'loan-extraction', exporters: [exporter],
    includeInternalSpans: false, excludeSpanTypes: [SpanType.MODEL_CHUNK, SpanType.MODEL_STEP],
  });
  runtimeMastra.registerExporter(exporter, instance, observability);
  const result = { observability, exporter };
  configured.set(runtimeMastra, result);
  return result;
}
