# Pinned Mastra / Temporal integration

The extraction worker uses the experimental **real `@mastra/temporal` adapter**.
Mastra is a library in each extraction worker; there is no central Mastra server.
The OCR and application workflows are native Temporal workflows.

| Package | Exact version |
| --- | --- |
| `@mastra/core` | 1.74.0 |
| `@mastra/temporal` | 0.4.12 |
| `@mastra/observability` | 1.18.3 |
| `@temporalio/{activity,client,common,plugin,testing,worker,workflow}` | 1.24.0 |
| `zod` | 4.6.5 |
| Node | >=24.11.0; local container pins 24.19.0 |

`package-lock.json` records the complete dependency graph and integrity hashes.
Install it with `npm ci`; do not install a floating `latest` version.

The adapter's direct Node requirement is 22.13, but the locked Babel 8 transform
dependencies require Node 22.18 or 24.11 and the locked telemetry dependency
requires at least Node 22.22. The application therefore requires Node 24.11 or
newer and the local container matches the verified Node 24.19 host runtime.

## Generated execution contract

`src/mastra/temporal.ts` calls `init({client, taskQueue, startToCloseTimeout})`.
`src/mastra/extraction.ts` imports both factories from that initialized module,
uses static workflow and step IDs, and commits this two-step workflow:

```text
extractRelevantFacts -> validateAndSaveEvidence
```

The Node entry module registers the workflow in a `Mastra` instance. The dedicated
worker passes `new MastraPlugin(entryFile)` to `Worker.create`. The plugin compiles
the Mastra graph into `node_modules/.mastra/workflow.mjs` and generated activity
bindings. Inspection of the **actual built files** established these names:

| Source ID | Generated Temporal name |
| --- | --- |
| `extract-application` | `extractApplicationWorkflow` |
| `extractRelevantFacts` | `extractRelevantFacts` activity |
| `validateAndSaveEvidence` | `validateAndSaveEvidence` activity |

The installed transform camel-cases hyphens/underscores and appends `Workflow`
unless already present. The generated name is distinct from the registration ID.

The native parent uses `executeChild('extractApplicationWorkflow', ...)`, with the
`loan-extraction` queue and explicit cancellation and parent-close policies. Its
argument list contains **one envelope**:

```ts
[{ inputData: { applicationId, documentHash, manifestRef, mode, analysisRevision } }]
```

The generated runtime returns:

```ts
{
  status: 'success',
  input: /* original compact input */,
  result: { extractionRef },
  state: undefined,
  steps: {
    extractRelevantFacts: { draftRef },
    validateAndSaveEvidence: { extractionRef }
  }
}
```

The binding and strict runtime schemas live in
`src/integration/analysis-child-contract.ts`. The parent validates the result
before using it. `TemporalRun.start()` adds its own wrapper around the generated
result and catches failures; the parent deliberately consumes the generated child
contract directly. No Temporal Client is imported into native workflow code.

Drafts contain model input/output metadata in shared object storage. Only artifact
references enter generated step history. The final artifact records extraction
attempts, prompt/schema/model revisions, hashes, evidence issues, and verification.
Successful immutable drafts and artifacts are reused; an unpersisted inference can
repeat following worker loss. This does not promise exactly-once model billing.

Live extraction also configures real Mastra observability inside the Node activity.
`src/mastra/diagnostics.ts` persists immutable S3 trace lifecycle records and the
extraction artifact retains their references. The exporter permits only opaque
correlation IDs, span types/times, model/provider identifiers, token counts and a
failure flag. It excludes document/model content, request headers, arbitrary
metadata, raw errors and hidden reasoning. Model chunk/step tracing is excluded to
keep this bounded. Tests exercise the actual Mastra observability bus without a
provider key and verify private content cannot escape the exporter.
The extraction runtime disables SDK console logging and automatic log export;
the lazy agent also uses the SDK's no-op logger. This prevents raw provider error
bodies from reaching logs before the activity sanitizes its Temporal failure.
Model input contains only selected financial sections or labeled financial
evidence, with original block IDs, text and coordinates. Unknown narrative and
mixed identity/evidence blocks are dropped; OCR token arrays are not sent. Missing
evidence therefore requires review rather than silently redacting citation text.

The Agent is constructed lazily inside Node-only extraction code. A top-level
Agent constructor has side effects that this release's transformer preserves,
which otherwise pulls Node dependencies into the generated workflow bundle. The
verified generated workflow module imports only Temporal workflow primitives and
Zod; it contains neither Agent nor client initialization.

## Effective options and failures

Inspection of adapter 0.4.12's published runtime shows that its activity proxy
forwards only `startToCloseTimeout`. Ordinary Mastra `retryConfig` does **not**
configure native Temporal retries in this version. The worker therefore loads the
native workflow outbound interceptor at
`src/integration/extraction-options-interceptor.ts`. It changes each generated
activity scheduling command to:

| Option | Effective value |
| --- | --- |
| Start to close | 90 seconds |
| Schedule to close | 5 minutes |
| Heartbeat timeout | 30 seconds |
| Retry attempts | 3 |
| Initial / maximum interval | 1 / 30 seconds |
| Backoff coefficient | 2 |
| Cancellation | Wait for cooperative activity cancellation |

This retains the generated graph and activities. The integration test inspects
Temporal history to verify the actual options, rather than inferring support from
the authoring API. Activities send five-second heartbeats, use cooperative abort
signals, and give provider work a 60-second deadline before the activity timeout.
Configuration/integrity failures use native nonretryable `ApplicationFailure`.
Exhausted generated activity failures reject the child; the parent persists a
technical error, never a policy FAIL. The adapter's suspend/resume APIs are not
used. Human review uses native Temporal Updates and conditions in the parent.

## Reproducible proof

Start local services with `npm run dev`, then run `npm run test:integration`.
The test uses a controlled OCR artifact to isolate the adapter contract; it does
not substitute OCR in the application walkthrough. It starts a native parent and
real generated child, observes completion of `extractRelevantFacts`, sends
`SIGKILL` to the extraction worker while validation is unfinished, starts a fresh
worker, and verifies the child returns the validated extraction reference. It
checks that the completed first activity occurs once and inspects generated
activity names, timeout settings and maximum attempts in history.

Verified on October 6, 2026: this native child recovery test passed in 51 seconds
against local Temporal dev server 1.4.1 (server 1.28.0). Execution
`integration-child-f844b8cd-2679-4709-84cf-e99c5096b58b` recorded both generated
activities with 90-second start-to-close, 300-second schedule-to-close and three
maximum attempts. The first completed once and the second recovered after SIGKILL.

Additional generated failure testing observed `extractRelevantFacts` exhaust
exactly three attempts with `PROVIDER_429`, producing native child and parent
workflow failures. Cancellation testing observed the generated child reach
`CANCELLED`, with workflow cancellation requested, activity cancellation requested,
a started activity canceled cooperatively, and workflow cancellation committed in
history. Worker heartbeat throttling is capped at five seconds so cooperative
cancellation and checkpoint heartbeats are not delayed by the SDK's default throttle.

After finalizing cache keys, immutable prompt metadata and native attempt counts,
all three generated integration tests passed together in 84 seconds. A final rerun
with metadata-only diagnostics, raw-error log suppression and minimized model
inputs passed all three tests in 85.54 seconds. Recovery child
`integration-child-40c6e4e9-1bfb-4b1c-9775-d488ebaaa43c` persisted successful native
attempt counts of one for extraction and two for validation, while retaining the
completed first step across SIGKILL. Unit tests
also verify a single bounded schema repair, malformed evidence routed to review,
provider throttling propagated to Temporal, nonretryable authentication failure,
and refusal to truncate evidence when the input budget is exceeded.

Use `npm run demo:seed` for the complete scanned-PDF application path and
`npm run demo:failure` for application-level worker recovery scenarios.

The adapter remains experimental. Live provider behavior requires the user's own
key and is separate from deterministic fixture-model throughput measurements.
Fixture mode replaces only inference; it runs actual OCR and the real generated
Mastra workflow and activities.
