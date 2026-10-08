# Local validation

Verified October 6, 2026 in the local Docker Compose environment. No remote
infrastructure was provisioned or deployed. The default runs used fixture model
responses with actual PDF rendering, Tesseract OCR, the real generated Mastra
Temporal workflow, evidence validation, policy, storage, and browser application.

## Reproducible environment

Node 24.19.0, npm 11.9.0, Docker 28.4.0, and Compose 2.40.3 were available on
the test host. Containers pin Node 24.19.0, PostgreSQL 16.6, Temporal CLI 1.4.1
(server 1.28.0), S3rver 3.7.1, Poppler 22.12.0, and Tesseract 5.3.0. Container
images use digest pins and executable packages use exact versions. The npm
lockfile includes integrity hashes; [INTEGRATION.md](INTEGRATION.md) records the
exact Mastra, Temporal SDK, and Zod versions and observed generated contracts.

`npm ci`, `npm run dev`, application seeding, strict typechecking, production
frontend build, and lint succeeded. Services bind only to host loopback and retain
local state in named Docker volumes. The host uses Docker's `vfs` driver, so the
documented compact-worker override was used: read-only locked local dependencies,
the same pinned runtime/OCR tools, and a private generated workflow cache per
worker. Ordinary Compose keeps application code and dependencies inside images.

## Automated checks

The full unit suite ran with the local PostgreSQL and object-store test bindings:

```sh
TEST_DATABASE_URL=postgres://loan_app:loan_demo@127.0.0.1:5432/loan_demo TEST_S3_ENDPOINT=http://127.0.0.1:9000 npm test
npm run test:integration
```

All **137 unit tests** passed, with no skips, in 18.39 seconds after the final
mixed-workload quota fix. Together with the 11 integration tests, **148 automated
tests passed**. Typecheck, lint, and the production frontend build also passed.

The unit checks cover exact policy boundaries and evidence precedence, pay
frequency normalization, payment arithmetic including zero APR, citations and
numeric OCR confidence, extraction budgets and bounded schema repair,
authentication, review idempotency, immutable object races, audit permissions,
diagnostic privacy, and bounded capacity recommendations.

All **11 real integration tests** passed together in 130.66 seconds. Eight native
application tests cover all nine scanned fixtures, concurrent/stale/duplicate
review commands, durable review through API and worker restarts, saving during a
scoped database fault, corrected immutable evidence revisions, pending final
audit recovery, lost commit acknowledgement, and cancellation before/after the
final commit. Review notes, corrections, and full quotes are verified absent from
workflow history. Three generated-workflow tests verify the native parent/child
contract, worker SIGKILL recovery between completed steps, three-attempt provider
failure exhaustion, effective timeouts/backoff, and cooperative cancellation.

All nine supplied fixtures matched their declared expectations after actual
container OCR: clear PASS, clear FAIL, borderline REVIEW, low-confidence REVIEW,
conflicting-evidence REVIEW, missing-income REVIEW, injection-resistant PASS,
payment-mismatch REVIEW, and zero-APR PASS. Source hashes, artifact references,
quotes, coordinates, policy results, and final audit data were checked together.

## Browser walkthrough

Chromium automation exercised the running GUI, including actual writes:

- Uploaded packets reached PASS, FAIL, and REVIEW through the GUI.
- A credit-score citation selected the correct page and matched its quoted OCR
  block and scaled highlight coordinates. The 390-pixel mobile view had no
  horizontal overflow.
- A reviewer without override permission could not choose an override action.
- Changing the cited score from 680 to unsupported 681 created immutable evidence
  revision 2, raised evidence issues, and prevented ordinary finalization.
- Restoring cited 680 created revision 3 and cleared those issues. Finalization
  committed simulated PASS while retaining the original REVIEW recommendation.
- The closed application's audit remained readable; the JSON export agreed with
  the GUI on the source hash, policy, evidence revisions, reviewer identity, three
  review commands, and final simulated decision. No browser runtime errors were
  observed.

Local evidence is retained in `.data/demo-results/browser/`, including
`summary.json`, `audit.json`, and desktop/mobile screenshots. The final reviewed
application is `c0ee0bee-c358-4bcc-886a-c2ff1b537b1a`.

## Worker and failure recovery

`npm run demo:failure` passed all six application-level scenarios:

| Scenario | Observed result |
| --- | --- |
| OCR worker SIGKILL mid-page | Completed page 3 kept its original hash and attempt 1; unfinished pages retried at attempt 2; render/manifest remained attempt 1; final PASS committed once. |
| Generated extraction worker SIGKILL | Completed extraction draft stayed at attempt 1 with its original hash; validation recovered at attempt 2; final PASS committed once. |
| Declared provider 429, recoverable | Two failures followed by successful attempt 3 and PASS. |
| Declared provider 429, exhausted | Exactly three attempts, then PROCESSING_ERROR. |
| Declared provider timeout, recoverable | Two failures followed by successful attempt 3 and PASS. |
| Declared provider timeout, exhausted | Exactly three attempts, then PROCESSING_ERROR. |

The report is
`.data/demo-results/failure-d43346a7-b84e-467a-a2ca-b34ccddbc3c5.json`.
These provider faults are declared fixture errors, not live HTTP timeout
measurements. Temporary workers were removed and normal workers restored.

## Cold horizontal-scaling measurement

Executed sequentially on the same local shared services:

```sh
npm run demo:load -- --cold --compare --count 100
```

Each phase processed 100 packets with unique internal OCR/extraction revisions,
forcing fresh rendering, all three page OCR activities, and fixture inference for
every application. Both phases committed exactly one final audit per application:
**200 PASS applications, zero duplicate final decisions**.

| Measurement | One replica per queue | Three replicas per queue |
| --- | ---: | ---: |
| Batch duration | 400.205 s | 204.814 s |
| Throughput | 0.2499 applications/s | 0.4882 applications/s |
| Application latency p50 | 366.618 s | 185.949 s |
| Application latency p95 | 394.574 s | 195.958 s |
| Maximum application latency | 397.038 s | 197.763 s |
| Aggregate activity queue delay p95 | 208.526 s | 65.356 s |
| Aggregate activity execution time p95 | 4.616 s | 5.843 s |

Measured throughput increased **1.95×**. Increasing replicas reduced queue delay;
it did not produce linear scaling or faster individual activity execution. Each
phase recorded 1,500 activity scheduling/execution samples. Application latency
includes admission and periodic API observation, while batch duration also
includes upload/resource sampling. The cold benchmark uses the internal workflow
start path to assign isolated processing revisions and retains transactional
database admission limits; it does not measure multipart HTTP upload throughput.
It is not a provider-latency measurement.

Per-worker allocations stayed at one CPU and 768 MiB for application/extraction,
or one CPU and 1,024 MiB for OCR. Activity slots stayed at 16 application, four OCR,
and four extraction per replica; at most four OCR pages run per document. The
application admission limit stayed at 200. The shared API, Temporal, PostgreSQL,
and object-store services were unchanged. No image builds or runtime tuning
occurred between measured phases.

The host had a four-CPU cgroup quota and 32 GiB cgroup memory limit. Kernel quota
checks on the restored workers confirmed `cpu.max = 100000 100000` and the
768/1,024 MiB `memory.max` limits. The nine workers in the larger phase therefore
shared a host with fewer CPUs than their combined allocations.

Sampled peaks below compare one versus three replicas. Memory/RSS values are
MiB, CPU values are Docker percentages, and each value is the maximum observed
for a single worker or process of that type. These are periodic samples, not
continuous maxima; short CPU sample percentages do not describe quota allocation.

| Worker | Docker memory peak, 1 → 3 | Largest process RSS, 1 → 3 | Docker CPU peak, 1 → 3 |
| --- | ---: | ---: | ---: |
| Application | 476.2 → 477.4 | 524.5 → 525.3 | 29.20% → 109.73% |
| OCR | 438.1 → 431.9 | 336.3 → 340.6 | 131.46% → 147.14% |
| Extraction | 572.9 → 623.8 | 611.2 → 628.2 | 41.45% → 83.28% |

Per-queue schedule-to-start p95 was 0.394 → 1.313 seconds for application,
224.611 → 93.606 seconds for OCR, and 6.993 → 1.072 seconds for extraction. OCR
queueing dominated the single-replica batch. Process RSS and Docker memory
accounting differ; summing process RSS can count shared pages more than once.

The complete report, sampled Docker CPU/memory, per-process RSS, and application
IDs are retained in
`.data/demo-results/load-2026-10-06T21-00-29-587Z.json`. Immutable extraction caches
can be reused in the default comparison without `--cold`; that measures a
different, cached workload.

## One hundred waiting reviews

```sh
npm run demo:load -- --reviews --count 100
npm run demo:capacity
```

The separate review batch uploaded through the API with three replicas per queue
and reused already verified immutable borderline artifacts. All 100 cases
reached REVIEW in 126.827 seconds (API-observed p50 99.278 seconds, p95 110.125
seconds). This is a different workload from the cold throughput comparison.

Each native parent remained RUNNING, and both its OCR and generated extraction
children were COMPLETED. Pending activities across all 300 executions totaled
**zero**. The batch had zero final audit events and zero duplicate decisions;
waiting for people did not consume processing slots or imply a decision.
Measurements are retained in
`.data/demo-results/load-2026-10-06T21-02-57-416Z.json`, with per-queue/resource
summaries in `.data/demo-results/load-summary-1791320627089.json`.

Exactly one worker per queue was restored afterward. The final read-only capacity
report succeeded with 103 open cases (100 new and three earlier cases), zero
current queue backlog, zero active activities, verified fixed worker limits,
and HOLD recommendations. The new quota guard observed fixture-only work; tests
also prove it holds extraction growth for live or unknown workload mode without
an explicit quota. `--apply` was never used. The cases, artifacts, and volumes
remain available for the GUI; `.data/demo-results/capacity-latest.json` records
the final observation.

## Remaining limits

- No provider key was supplied. Live Mastra inference, provider billing, quotas,
  and the real HTTP deadline/cancellation path remain unmeasured. Metadata-only
  Mastra diagnostics and prompt minimization were tested without a live provider.
- Financial-section selection and identity minimization use deterministic English
  labels. They are not a general PII-redaction guarantee for arbitrary PDFs.
  Review content and full artifacts stay outside workflow history.
- Only the immutable `demo-auto-loan-v1` policy is supported. Adding a policy
  version must preserve evaluation and replay of existing snapshots; changing
  version 1 in place would violate that contract.
- The 24-hour overdue timer is implemented as a durable native Temporal timer;
  this validation did not wait 24 hours or advance a time-skipping test clock.
  Elapsed review time never produces a decision.
- The real experimental adapter is pinned and proven for this graph; compatibility
  with future adapter releases is not implied. A model call lost before its
  immutable result is saved may repeat.
- Capacity observations and recommendation logic are tested; a sustained
  `--watch --apply` controller run has not been measured. Queue statistics are
  approximate and history/provider retry sampling is bounded.
- This is a local educational system using fictional policy, fixture verification,
  demo credentials, development Temporal/S3 services, and append-only application
  audit permissions. Shared deployment, real document verification, external
  authentication, production retention, and lender-approved decisions require
  separate work.
- A new user's machine and a published cloud environment snapshot have not been
  tested. The setup draft is saved for user review; local startup and restart were
  exercised here with the pinned dependencies and services.
