import {
  StrictMode,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  fieldNames,
  rawExtractionSchema,
  type Citation,
  type ExtractionArtifact,
  type FieldName,
  type OcrManifest,
  type PolicyDecision,
  type RawExtraction,
  type RuleResult,
} from "../src/contracts.js";
import type {
  ApplicationAudit,
  ApplicationProjection,
  ReviewCase,
} from "../src/storage.js";
import type { ReviewerIdentity } from "../src/api/auth.js";
import type { ApplicationState } from "../src/workflows/application-contract.js";
import {
  asDecision,
  citationConfidence,
  correctionFromArtifact,
  fieldLabels,
  formatFact,
  reasons,
  statusLabel,
  visibleStatus,
  withWorkflowProgress,
} from "./presentation.js";
import "./style.css";

interface Configuration {
  brandName: string;
  accentColor: string;
  mode: "fixture" | "live";
  authentication: "fixture-selector" | "password";
  reviewers: ReviewerIdentity[];
  maxUploadBytes: number;
}
interface Evidence {
  ocr: OcrManifest | null;
  extraction: ExtractionArtifact | null;
}
interface ReviewDetail {
  application: ApplicationProjection;
  reviewCase: ReviewCase;
}
type ReviewAction =
  | "CORRECT"
  | "VERIFY"
  | "FINALIZE"
  | "OVERRIDE"
  | "REQUEST_DOCUMENTS";
interface Command {
  commandId: string;
  applicationId: string;
  workflowId: string;
  workflowRunId: string;
  caseRevision: number;
  evidenceRevision: number;
  policyVersion: string;
  action: ReviewAction;
  note: string;
  corrections?: RawExtraction;
  decision?: "PASS" | "FAIL";
}
interface PendingCommand {
  body: Command;
  unconfirmed: boolean;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
  }
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  const body: unknown =
    response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    const details =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    throw new ApiError(
      typeof details["message"] === "string"
        ? details["message"]
        : `Request failed (${response.status}).`,
      response.status,
      details,
    );
  }
  return body as T;
}
function errorText(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "The local service could not be reached. Check that it is running, then retry.";
}

function useResource<T>(path: string | null, interval = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const previousPath = useRef(path);
  useEffect(() => {
    let active = true;
    let inFlight = false;
    if (previousPath.current !== path) setData(undefined);
    previousPath.current = path;
    setError("");
    setLoading(Boolean(path));
    const read = async () => {
      if (!path || inFlight) return;
      inFlight = true;
      try {
        const result = await request<T>(path);
        if (active) {
          setData(result);
          setError("");
        }
      } catch (error) {
        if (active) setError(errorText(error));
      } finally {
        inFlight = false;
        if (active) setLoading(false);
      }
    };
    void read();
    const timer = interval
      ? window.setInterval(() => {
          void read();
        }, interval)
      : undefined;
    return () => {
      active = false;
      if (timer) window.clearInterval(timer);
    };
  }, [path, interval, version]);
  return {
    data,
    error,
    loading,
    refresh: () => setVersion((previous) => previous + 1),
  };
}

function useRoute() {
  const [route, setRoute] = useState(
    window.location.hash.slice(1) || "applications",
  );
  useEffect(() => {
    const update = () => {
      setRoute(window.location.hash.slice(1) || "applications");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}
function go(route: string) {
  window.location.hash = route;
}
function time(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
function shortId(id: string) {
  return id.slice(0, 8).toUpperCase();
}
function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function Icon({
  name,
}: {
  name: "packet" | "review" | "arrow" | "upload" | "check";
}) {
  const paths = {
    packet: (
      <>
        <path d="M7 3h7l4 4v14H7z" />
        <path d="M14 3v5h4M10 12h5m-5 4h5" />
      </>
    ),
    review: (
      <>
        <path d="M9 4h11v14H9zM4 8v13h11" />
        <path d="m12 11 2 2 4-4" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" />
      </>
    ),
    check: <path d="m5 12 4 4 10-10" />,
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
function Badge({ status }: { status: string }) {
  return (
    <span className={`badge status-${status.toLowerCase()}`}>
      {statusLabel(status)}
    </span>
  );
}
function Simulation() {
  return <span className="simulation">Educational simulation</span>;
}
function Notice({
  children,
  type = "error",
}: {
  children: ReactNode;
  type?: "error" | "info" | "success";
}) {
  return (
    <div
      className={`notice ${type}`}
      role={type === "error" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
function LoadState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string;
  retry: () => void;
}) {
  return (
    <>
      {loading && (
        <div className="loading" role="status">
          <span className="spinner" />
          Loading…
        </div>
      )}
      {error && (
        <Notice>
          {error}{" "}
          <button className="text-button" onClick={retry}>
            Retry
          </button>
        </Notice>
      )}
    </>
  );
}
function PageHeading({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {children && <p className="lede">{children}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}

function App() {
  const config = useResource<Configuration>("/api/config");
  const [identity, setIdentity] = useState<ReviewerIdentity | null>();
  const [sessionError, setSessionError] = useState("");
  const route = useRoute();
  useEffect(() => {
    request<{ identity: ReviewerIdentity }>("/api/session")
      .then((result) => setIdentity(result.identity))
      .catch((error) => {
        setIdentity(null);
        if (!(error instanceof ApiError && error.status === 401))
          setSessionError(errorText(error));
      });
  }, []);
  async function logout() {
    try {
      await request("/api/session", { method: "DELETE" });
      setIdentity(null);
      setSessionError("");
    } catch (error) {
      setSessionError(errorText(error));
    }
  }
  const accent = config.data?.accentColor ?? "#315d4e";
  const theme = {
    "--accent": /^#[0-9a-f]{6}$/i.test(accent) ? accent : "#315d4e",
  } as CSSProperties;
  const [surface, id] = route.split("/");
  return (
    <div className="app" style={theme}>
      <a
        className="skip-link"
        href="#content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("content")?.focus();
          document.getElementById("content")?.scrollIntoView();
        }}
      >
        Skip to content
      </a>
      <aside className="sidebar">
        <a className="brand" href="#applications">
          <span className="brand-mark" aria-hidden="true">
            ◇
          </span>
          <span>
            {config.data?.brandName ?? "Vehicle finance"}
            <small>Paperwork review</small>
          </span>
        </a>
        <p className="workspace-label">Local workspace</p>
        <nav aria-label="Main navigation">
          <a
            href="#applications"
            className={
              surface === "applications" || surface === "audit" ? "active" : ""
            }
          >
            <Icon name="packet" />
            Applications
          </a>
          <a href="#reviews" className={surface === "reviews" ? "active" : ""}>
            <Icon name="review" />
            Human review
          </a>
        </nav>
        <div className="sidebar-footer">
          <p>
            Fictional data.
            <br />
            Invented lending thresholds.
          </p>
          <p className="small">No lender submission or disbursement.</p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div>
            <Simulation />
            {config.data && (
              <span className={`mode mode-${config.data.mode}`}>
                {config.data.mode === "fixture"
                  ? "Fixture mode · actual OCR"
                  : "Live model mode"}
              </span>
            )}
          </div>
          <div className="session">
            {identity && (
              <>
                <span>
                  {identity.displayName}
                  <small>
                    {identity.role === "override-reviewer"
                      ? "Override-capable reviewer"
                      : "Reviewer"}
                  </small>
                </span>
                <button
                  className="text-button"
                  onClick={() => {
                    void logout();
                  }}
                >
                  Sign out
                </button>
              </>
            )}
          </div>
        </header>
        <main id="content" tabIndex={-1}>
          <LoadState
            loading={config.loading}
            error={config.error}
            retry={config.refresh}
          />
          {sessionError && <Notice>{sessionError}</Notice>}
          {config.data && identity === undefined && (
            <div className="loading" role="status">
              Checking reviewer session…
            </div>
          )}
          {config.data && identity === null && (
            <Login configuration={config.data} onLogin={setIdentity} />
          )}
          {config.data && identity && (
            <>
              {surface === "reviews" ? (
                id ? (
                  <ReviewPage key={id} id={id} identity={identity} />
                ) : (
                  <ReviewQueue />
                )
              ) : surface === "audit" && id ? (
                <AuditPage key={id} id={id} />
              ) : id ? (
                <ApplicationPage key={id} id={id} configuration={config.data} />
              ) : (
                <Applications configuration={config.data} />
              )}
            </>
          )}
        </main>
        <footer className="page-footer">
          Local educational application · Demo policy v1 · Human review remains
          available
        </footer>
      </div>
    </div>
  );
}

function Login({
  configuration,
  onLogin,
}: {
  configuration: Configuration;
  onLogin: (identity: ReviewerIdentity) => void;
}) {
  const [reviewerId, setReviewerId] = useState(
    configuration.reviewers[0]?.id ?? "",
  );
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await request<{ identity: ReviewerIdentity }>(
        "/api/session",
        {
          method: "POST",
          body: JSON.stringify(
            configuration.authentication === "password"
              ? { reviewerId, password }
              : { reviewerId },
          ),
        },
      );
      setPassword("");
      onLogin(result.identity);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-layout">
      <div className="login-intro">
        <p className="eyebrow">Document to decision</p>
        <h1>
          A clear view of
          <br />
          every application.
        </h1>
        <p>
          Read the packet, follow the evidence, and understand the fictional
          rules behind each simulated outcome.
        </p>
        <div className="intro-line" />
        <p className="small">
          This local demonstration uses synthetic loan paperwork. PASS and FAIL
          are educational outcomes.
        </p>
      </div>
      <section className="panel login-panel">
        <p className="eyebrow">Reviewer access</p>
        <h2>Open your workspace</h2>
        <p className="muted">
          {configuration.authentication === "fixture-selector"
            ? "Choose a local demo identity to begin."
            : "Sign in with your configured reviewer account."}
        </p>
        <form
          onSubmit={(event) => {
            void login(event);
          }}
        >
          {configuration.authentication === "fixture-selector" ? (
            <fieldset className="identity-options">
              <legend className="sr-only">Demo reviewer identity</legend>
              {configuration.reviewers.map((reviewer) => (
                <label
                  className={
                    reviewerId === reviewer.id
                      ? "identity selected"
                      : "identity"
                  }
                  key={reviewer.id}
                >
                  <input
                    type="radio"
                    name="reviewer"
                    value={reviewer.id}
                    checked={reviewerId === reviewer.id}
                    onChange={() => setReviewerId(reviewer.id)}
                  />
                  <span>
                    {reviewer.displayName}
                    <small>
                      {reviewer.role === "override-reviewer"
                        ? "Includes explicit educational overrides"
                        : "Review, correct, and verify evidence"}
                    </small>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : (
            <>
              <label>
                Reviewer ID
                <input
                  required
                  autoComplete="username"
                  value={reviewerId}
                  onChange={(event) => setReviewerId(event.target.value)}
                />
              </label>
              <label>
                Password
                <input
                  required
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </>
          )}
          {error && <Notice>{error}</Notice>}
          <button className="primary wide" disabled={busy || !reviewerId}>
            {busy ? "Signing in…" : "Enter workspace"}
            <Icon name="arrow" />
          </button>
        </form>
        <p className="small muted">
          {configuration.authentication === "fixture-selector"
            ? "Demo identities apply only to this local fixture workspace."
            : "Account access is configured by your local operator."}
        </p>
      </section>
    </div>
  );
}

function UploadForm({
  configuration,
  parentId,
  onUploaded,
}: {
  configuration: Configuration;
  parentId?: string;
  onUploaded?: () => void;
}) {
  const [file, setFile] = useState<File>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!file) {
      setError("Choose one PDF packet.");
      return;
    }
    if (file.size > configuration.maxUploadBytes) {
      setError("The packet must be no larger than 20 MiB.");
      return;
    }
    setBusy(true);
    const body = new FormData();
    body.append("packet", file);
    if (parentId) body.append("parentApplicationId", parentId);
    try {
      const result = await request<{ applicationId: string }>(
        "/api/applications",
        { method: "POST", body },
      );
      onUploaded?.();
      go(`applications/${result.applicationId}`);
    } catch (error) {
      setError(errorText(error));
      if (
        error instanceof ApiError &&
        typeof error.body["applicationId"] === "string"
      )
        go(`applications/${error.body["applicationId"]}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="upload-form"
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <div className="upload-target">
        <span className="upload-icon">
          <Icon name="upload" />
        </span>
        <div>
          <h3>
            {parentId
              ? "Upload a replacement packet"
              : "Start with a PDF packet"}
          </h3>
          <p>
            Application, income evidence, vehicle quote, and synthetic bureau
            summary in one PDF.
          </p>
          <label className="file-picker">
            <span className="secondary">Choose PDF</span>
            <input
              ref={input}
              type="file"
              accept="application/pdf,.pdf"
              aria-label="Choose application PDF packet"
              disabled={busy}
              onChange={(event) => {
                setFile(event.target.files?.[0]);
                setError("");
              }}
            />
            <span className="filename">
              {file
                ? `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MiB`
                : "No packet selected"}
            </span>
          </label>
          <p className="small muted">
            Up to 20 MiB and 25 pages. Password-protected PDFs are unsupported.
          </p>
          {configuration.mode === "fixture" && !parentId && (
            <p className="small">
              <a
                className="text-link"
                href="/sample-loan-application.pdf"
                download="sample-loan-application.pdf"
              >
                Download sample PDF ↓
              </a>
              <br />
              Choose the downloaded synthetic packet above, then select Review
              packet. Its expected result in fixture mode is an educational
              simulated PASS.
            </p>
          )}
        </div>
      </div>
      {error && <Notice>{error}</Notice>}
      <div className="upload-footer">
        <span className="small muted">
          {configuration.mode === "fixture"
            ? "Fixture mode replaces model inference; every page still runs through OCR."
            : "New source evidence requires reviewer verification."}
        </span>
        <button className="primary" disabled={busy || !file}>
          {busy
            ? "Uploading…"
            : parentId
              ? "Start linked revision"
              : "Review packet"}
          <Icon name="arrow" />
        </button>
      </div>
    </form>
  );
}

function Applications({ configuration }: { configuration: Configuration }) {
  const applications = useResource<{ applications: ApplicationProjection[] }>(
    "/api/applications",
    3000,
  );
  const list = applications.data?.applications ?? [];
  return (
    <>
      <PageHeading
        eyebrow="Application workspace"
        title="Loan paperwork, made readable."
      >
        Upload a packet and follow its evidence through the demo review process.
      </PageHeading>
      <section className="panel">
        <UploadForm
          configuration={configuration}
          onUploaded={applications.refresh}
        />
      </section>
      <section className="applications-section">
        <div className="section-heading">
          <h2>Recent applications</h2>
          <span className="muted small">
            {list.length} {list.length === 1 ? "application" : "applications"}
          </span>
        </div>
        <LoadState
          loading={applications.loading}
          error={applications.error}
          retry={applications.refresh}
        />
        {applications.data && !list.length ? (
          <div className="empty-state">
            <Icon name="packet" />
            <h3>Your first review starts here</h3>
            <p>Upload a supplied synthetic PDF to see the process in action.</p>
          </div>
        ) : (
          list.length > 0 && <ApplicationTable applications={list} />
        )}
      </section>
    </>
  );
}
function ApplicationTable({
  applications,
}: {
  applications: ApplicationProjection[];
}) {
  return (
    <div className="table-wrap">
      <table className="application-table">
        <caption className="sr-only">
          Applications and their current processing status
        </caption>
        <thead>
          <tr>
            <th>Application</th>
            <th>Received</th>
            <th>Status</th>
            <th>Mode</th>
            <th>
              <span className="sr-only">Open application</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {applications.map((application) => (
            <tr key={application.id}>
              <td>
                <a
                  className="case-link"
                  href={`#applications/${application.id}`}
                >
                  Packet {shortId(application.id)}
                </a>
                <span className="table-subtitle">
                  Revision {application.revision}
                  {application.parentApplicationId
                    ? " · Linked replacement"
                    : ""}
                </span>
              </td>
              <td>{time(application.createdAt)}</td>
              <td>
                <Badge status={visibleStatus(application)} />
              </td>
              <td>
                <span className="mode-text">{application.mode}</span>
              </td>
              <td>
                <a
                  className="row-arrow"
                  href={`#applications/${application.id}`}
                  aria-label={`Open application ${shortId(application.id)}`}
                >
                  <Icon name="arrow" />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const progressSteps = [
  { statuses: ["UPLOADED"], label: "Packet received" },
  { statuses: ["OCR"], label: "Read pages" },
  { statuses: ["EXTRACTING"], label: "Extract evidence" },
  { statuses: ["EVALUATING"], label: "Evaluate rules" },
  { statuses: ["REVIEW"], label: "Human review" },
  { statuses: ["SAVING", "AUDIT_PENDING"], label: "Save audit" },
];
function Progress({ application }: { application: ApplicationProjection }) {
  const status = visibleStatus(application);
  const terminal = ["PASS", "FAIL", "NEEDS_DOCUMENTS", "CANCELLED"].includes(
    status,
  );
  const step = progressSteps.findIndex((item) =>
    item.statuses.includes(status),
  );
  return (
    <ol className="progress" aria-label="Application processing progress">
      {progressSteps.map((item, index) => (
        <li
          className={
            terminal || index < step ? "done" : index === step ? "current" : ""
          }
          key={item.label}
        >
          <span>
            {terminal || index < step ? <Icon name="check" /> : index + 1}
          </span>
          {item.label}
          {index === 4 && <small>When required</small>}
        </li>
      ))}
    </ol>
  );
}

function Outcome({ application }: { application: ApplicationProjection }) {
  const status = visibleStatus(application);
  const decision =
    asDecision(application.data["finalDecision"]) ??
    asDecision(application.data["recommendation"]);
  const override = application.data["override"] === true;
  const reviewerFinalized = application.data["decisionAuthority"] === "reviewer";
  const descriptions: Record<string, string> = {
    PASS: reviewerFinalized
      ? "A reviewer finalized an educational PASS after inspecting the cited evidence and demo rule results."
      : "The application meets the fictional demo thresholds.",
    FAIL: reviewerFinalized
      ? "A reviewer finalized an educational FAIL after inspecting the cited evidence and demo rule results."
      : "The application falls outside one or more fictional demo thresholds.",
    REVIEW:
      "A reviewer must resolve the evidence or consider a borderline financial result.",
    INPUT_ERROR:
      "This packet could not be read as a supported, unencrypted PDF. Upload a corrected packet.",
    PROCESSING_ERROR:
      "Processing stopped after a technical error. A linked retry can start a fresh attempt.",
    NEEDS_DOCUMENTS:
      "The reviewer requested a replacement packet. Upload it to start a linked application revision.",
    CANCELLED: "This attempt was cancelled.",
    SAVING:
      "Your review is being saved. A final outcome appears after its audit record is committed.",
    AUDIT_PENDING:
      "The audit record is being saved. The final outcome will appear after that write completes.",
  };
  return (
    <section
      className={`outcome outcome-${status.toLowerCase()}`}
      aria-live="polite"
    >
      <div>
        <Simulation />
        {override && <span className="override-label">OVERRIDE</span>}
        <h2>{statusLabel(status)}</h2>
        <p>
          {override
            ? "An authorized reviewer made an explicit educational override. The original rule recommendation is retained in the audit."
            : (descriptions[status] ??
              "Your packet is processing. This page updates automatically.")}
        </p>
        {application.data["note"] &&
        typeof application.data["note"] === "string" ? (
          <p className="review-note">
            Reviewer note: {application.data["note"]}
          </p>
        ) : null}
        {["INPUT_ERROR", "PROCESSING_ERROR"].includes(status) &&
          textValue(application.data["code"]) && (
            <p className="small">
              Error code: <code>{textValue(application.data["code"])}</code>
            </p>
          )}
        {decision && ["PASS", "FAIL", "REVIEW"].includes(status) && (
          <ReasonList codes={decision.reasonCodes} />
        )}
      </div>
      <div className="outcome-actions">
        {status === "REVIEW" && (
          <a className="primary" href={`#reviews/${application.id}`}>
            Open review
            <Icon name="arrow" />
          </a>
        )}
        <a className="secondary" href={`#audit/${application.id}`}>
          View audit
        </a>
      </div>
    </section>
  );
}
function ReasonList({ codes }: { codes: readonly string[] }) {
  return codes.length ? (
    <ul className="reason-list">
      {codes.map((code) => (
        <li key={code}>
          {reasons[code] ?? code.replaceAll("_", " ").toLowerCase()}
          <span className="reason-code">{code}</span>
        </li>
      ))}
    </ul>
  ) : null;
}

function ResumeProcessing({
  id,
  onResumed,
}: {
  id: string;
  onResumed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function resume() {
    setBusy(true);
    setError("");
    try {
      await request(`/api/applications/${id}/resume`, { method: "POST" });
      onResumed();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Notice type="info">
      <p>
        The processing start could not be confirmed. Resume this application to
        safely retry the same attempt.
      </p>
      <button
        className="primary"
        disabled={busy}
        onClick={() => {
          void resume();
        }}
      >
        {busy ? "Resuming…" : "Resume processing"}
      </button>
      {error && (
        <p className="resume-error" role="alert">
          {error}
        </p>
      )}
    </Notice>
  );
}

function ApplicationPage({
  id,
  configuration,
}: {
  id: string;
  configuration: Configuration;
}) {
  const resource = useResource<{
    application: ApplicationProjection;
    workflowState?: ApplicationState | null;
  }>(`/api/applications/${id}`, 2000);
  const evidence = useResource<Evidence>(
    `/api/applications/${id}/evidence`,
    3000,
  );
  const application = resource.data
    ? withWorkflowProgress(
        resource.data.application,
        resource.data.workflowState,
      )
    : undefined;
  const status = application ? visibleStatus(application) : "";
  return (
    <>
      <a className="back-link" href="#applications">
        ← All applications
      </a>
      <PageHeading
        eyebrow="Application detail"
        title={`Packet ${shortId(id)}`}
        actions={
          <a
            className="secondary"
            href={`/api/applications/${id}/document`}
            target="_blank"
            rel="noreferrer"
          >
            Open original PDF ↗
          </a>
        }
      >
        {application
          ? `Received ${time(application.createdAt)} · Application revision ${application.revision}`
          : "Application status and cited evidence"}
      </PageHeading>
      <LoadState
        loading={resource.loading}
        error={resource.error}
        retry={resource.refresh}
      />
      {application && (
        <>
          <Outcome application={application} />
          {application.stage === "START_PENDING" && (
            <ResumeProcessing id={id} onResumed={resource.refresh} />
          )}
          <Progress application={application} />
          {application.parentApplicationId && (
            <p className="small muted">
              Linked to{" "}
              <a href={`#applications/${application.parentApplicationId}`}>
                packet {shortId(application.parentApplicationId)}
              </a>
              .
            </p>
          )}
          {["NEEDS_DOCUMENTS", "INPUT_ERROR", "PROCESSING_ERROR"].includes(
            status,
          ) && (
            <section className="panel">
              <UploadForm configuration={configuration} parentId={id} />
            </section>
          )}
          <LoadState
            loading={false}
            error={evidence.error}
            retry={evidence.refresh}
          />
          {evidence.data?.extraction && (
            <section className="panel evidence-summary">
              <div className="section-heading">
                <h2>Extracted evidence</h2>
                <span className="small muted">
                  Evidence revision {application.evidenceRevision}
                </span>
              </div>
              <FactGrid artifact={evidence.data.extraction} />
              <a className="text-link" href={`#audit/${id}`}>
                Inspect sources and rule results →
              </a>
            </section>
          )}
          <details className="technical-details">
            <summary>Application identifiers and source hash</summary>
            <IdentityDetails application={application} />
          </details>
        </>
      )}
    </>
  );
}

function FactGrid({ artifact }: { artifact: ExtractionArtifact }) {
  return (
    <dl className="fact-grid">
      {fieldNames.map((name) => (
        <div key={name}>
          <dt>{fieldLabels[name]}</dt>
          <dd>{formatFact(name, artifact.result.facts[name])}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReviewQueue() {
  const resource = useResource<{ cases: ReviewCase[] }>("/api/reviews", 3000);
  const cases = resource.data?.cases ?? [];
  return (
    <>
      <PageHeading
        eyebrow="Human review"
        title="Give the evidence a closer look."
      >
        Resolve source issues, correct cited values, or finalize a simulated
        outcome.
      </PageHeading>
      <div className="section-heading">
        <h2>Open cases</h2>
        <span className="small muted">{cases.length} waiting for review</span>
      </div>
      <LoadState
        loading={resource.loading}
        error={resource.error}
        retry={resource.refresh}
      />
      {resource.data && !cases.length && (
        <div className="empty-state">
          <Icon name="check" />
          <h3>No cases waiting</h3>
          <p>
            Applications that need evidence checks or fall in a review band
            appear here.
          </p>
          <a href="#applications" className="secondary">
            View applications
          </a>
        </div>
      )}
      <div className="review-cards">
        {cases.map((reviewCase) => {
          const decision = asDecision(reviewCase.payload["decision"]);
          return (
            <article
              className="panel review-card"
              key={reviewCase.applicationId}
            >
              <div className="review-card-top">
                <span className="eyebrow">
                  Packet {shortId(reviewCase.applicationId)}
                </span>
                {reviewCase.overdue && (
                  <span className="overdue">Overdue · remains open</span>
                )}
              </div>
              <h2>
                {decision?.reasonCodes.some((code) =>
                  [
                    "EVIDENCE_MISSING",
                    "EVIDENCE_CONFLICT",
                    "VERIFICATION_REQUIRED",
                    "OCR_LOW_CONFIDENCE",
                  ].includes(code),
                )
                  ? "Evidence needs attention"
                  : "Borderline demo result"}
              </h2>
              <ReasonList codes={decision?.reasonCodes ?? []} />
              <div className="review-card-footer">
                <span className="small muted">
                  Opened {time(reviewCase.openedAt)}
                  <br />
                  Case {reviewCase.caseRevision} · Evidence{" "}
                  {reviewCase.evidenceRevision}
                </span>
                <a
                  className="primary"
                  href={`#reviews/${reviewCase.applicationId}`}
                >
                  Review case
                  <Icon name="arrow" />
                </a>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

function RulesTable({ decision }: { decision?: PolicyDecision }) {
  if (!decision)
    return (
      <p className="muted">
        Rule results will appear after evidence evaluation.
      </p>
    );
  const names: Record<string, string> = {
    evidence: "Evidence quality",
    terms: "Loan terms & payment",
    credit: "Credit score",
    dti: "Debt-to-income",
    ltv: "Loan-to-value",
  };
  function ruleValue(rule: RuleResult) {
    if (rule.numerator !== undefined && rule.denominator !== undefined)
      return rule.denominator > 0
        ? `${((rule.numerator / rule.denominator) * 100).toFixed(2)}%`
        : "Invalid denominator";
    return rule.value !== undefined ? String(rule.value) : "—";
  }
  function threshold(rule: RuleResult): string {
    const values = rule.thresholds;
    if (rule.id === "credit")
      return `PASS ≥ ${values["passMin"] ?? 700}; REVIEW ≥ ${values["reviewMin"] ?? 640}`;
    if (rule.id === "dti" || rule.id === "ltv")
      return `PASS ≤ ${(values["passBps"] ?? (rule.id === "dti" ? 3600 : 10000)) / 100}%; REVIEW ≤ ${(values["reviewMaxBps"] ?? (rule.id === "dti" ? 4500 : 11000)) / 100}%`;
    if (rule.id === "terms")
      return "36–84 months; APR 0–30%; payment within $1";
    return "Complete, consistent, verified; numeric OCR ≥ 90%";
  }
  return (
    <div className="table-wrap">
      <table className="rules-table">
        <caption className="sr-only">Pinned fictional policy results</caption>
        <thead>
          <tr>
            <th>Demo rule</th>
            <th>Observed</th>
            <th>Thresholds</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {decision.rules.map((rule) => (
            <tr key={rule.id}>
              <td>
                <strong>{names[rule.id]}</strong>
                {rule.reasonCodes.map((code) => (
                  <span className="rule-reason" key={code}>
                    {reasons[code] ?? code}
                  </span>
                ))}
              </td>
              <td>
                {ruleValue(rule)}
                {rule.numerator !== undefined && (
                  <span className="table-subtitle">
                    {rule.numerator} / {rule.denominator}
                  </span>
                )}
              </td>
              <td className="small">
                {threshold(rule)}
                <details className="rule-thresholds">
                  <summary>Exact rule values</summary>
                  <pre>{JSON.stringify(rule, null, 2)}</pre>
                </details>
              </td>
              <td>
                <Badge status={rule.band} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourceViewer({
  id,
  evidence,
  selected,
  onSelect,
}: {
  id: string;
  evidence: Evidence;
  selected: Citation | null;
  onSelect: (citation: Citation) => void;
}) {
  const [pageNumber, setPageNumber] = useState(1);
  const [imageError, setImageError] = useState(false);
  useEffect(() => {
    if (selected) {
      setPageNumber(selected.page);
      setImageError(false);
    }
  }, [selected]);
  const page = evidence.ocr?.pages.find(
    (page) => page.pageNumber === pageNumber,
  );
  const bbox = selected?.page === pageNumber ? selected.boundingBox : null;
  return (
    <section className="panel source-panel">
      <div className="section-heading">
        <h2>Source packet</h2>
        <a
          className="text-link small"
          href={`/api/applications/${id}/document#page=${pageNumber}`}
          target="_blank"
          rel="noreferrer"
        >
          Original PDF ↗
        </a>
      </div>
      <div className="page-toolbar">
        <label>
          Page{" "}
          <select
            value={pageNumber}
            onChange={(event) => {
              setPageNumber(Number(event.target.value));
              setImageError(false);
            }}
          >
            {evidence.ocr?.pages.map((page) => (
              <option key={page.pageNumber} value={page.pageNumber}>
                {page.pageNumber} of {evidence.ocr!.pages.length}
              </option>
            )) ?? <option value="1">1</option>}
          </select>
        </label>
        <span className="small muted">
          {selected?.page === pageNumber
            ? "Cited source highlighted"
            : "Choose a citation to highlight it"}
        </span>
      </div>
      {page && !imageError ? (
        <div
          className="page-image"
          style={{ aspectRatio: `${page.width} / ${page.height}` }}
        >
          <img
            src={`/api/applications/${id}/pages/${pageNumber}/image`}
            alt={`OCR source page ${pageNumber}`}
            onError={() => setImageError(true)}
          />
          {bbox && (
            <div
              className="source-highlight"
              aria-label={`Highlighted citation: ${selected?.quote}`}
              style={{
                left: `${(bbox.x / page.width) * 100}%`,
                top: `${(bbox.y / page.height) * 100}%`,
                width: `${(bbox.width / page.width) * 100}%`,
                height: `${(bbox.height / page.height) * 100}%`,
              }}
            />
          )}
        </div>
      ) : (
        <div className="source-empty">
          <p>
            {imageError
              ? "The rendered page is unavailable. Open the original PDF to inspect its source."
              : "Rendered pages will appear when OCR completes."}
          </p>
          <a
            href={`/api/applications/${id}/document#page=${pageNumber}`}
            target="_blank"
            rel="noreferrer"
            className="secondary"
          >
            Open PDF page {pageNumber}
          </a>
        </div>
      )}
      {selected && (
        <div className="selected-quote">
          <p className="eyebrow">Selected evidence · Page {selected.page}</p>
          <blockquote>{selected.quote}</blockquote>
          <span className="small muted">Block {selected.blockId}</span>
        </div>
      )}
      <details className="ocr-text">
        <summary>Read OCR text for page {pageNumber}</summary>
        {page?.blocks.map((block) => (
          <button
            key={block.id}
            className="ocr-block"
            onClick={() =>
              onSelect({
                page: page.pageNumber,
                blockId: block.id,
                quote: block.text,
                boundingBox: block.boundingBox,
              })
            }
          >
            <span className="small muted">
              {block.section} ·{" "}
              {block.confidence === null
                ? "Confidence unavailable"
                : `${block.confidence.toFixed(1)}% block confidence`}
            </span>
            <span>{block.text}</span>
          </button>
        ))}
      </details>
    </section>
  );
}

function EvidenceFields({
  artifact,
  ocr,
  selected,
  onSelect,
}: {
  artifact: ExtractionArtifact;
  ocr: OcrManifest | null;
  selected: Citation | null;
  onSelect: (citation: Citation) => void;
}) {
  return (
    <div className="evidence-fields">
      {fieldNames.map((name) => (
        <section className="evidence-field" key={name}>
          <div className="field-heading">
            <h3>{fieldLabels[name]}</h3>
            <strong>{formatFact(name, artifact.result.facts[name])}</strong>
          </div>
          {artifact.result.fields[name].citations.length ? (
            artifact.result.fields[name].citations.map((citation, index) => {
              const confidence = ocr ? citationConfidence(citation, ocr) : null;
              return (
                <button
                  className={`citation ${selected?.blockId === citation.blockId && selected.page === citation.page ? "selected" : ""}`}
                  key={`${citation.page}:${citation.blockId}:${index}`}
                  onClick={() => onSelect(citation)}
                >
                  <span className="citation-meta">
                    <span>Page {citation.page} ↗</span>
                    <span
                      className={
                        confidence !== null && confidence < 90
                          ? "low-confidence"
                          : ""
                      }
                    >
                      {confidence === null
                        ? "Numeric OCR confidence unavailable"
                        : `${confidence.toFixed(1)}% numeric OCR`}
                    </span>
                  </span>
                  <q>{citation.quote}</q>
                </button>
              );
            })
          ) : (
            <p className="small muted">No cited source established.</p>
          )}
        </section>
      ))}
    </div>
  );
}

function ValidationIssues({ artifact }: { artifact: ExtractionArtifact }) {
  return (
    <>
      {artifact.result.issues.length > 0 && (
        <div className="issue-panel">
          <h3>Evidence requiring attention</h3>
          <ul>
            {artifact.result.issues.map((issue, index) => (
              <li key={`${issue.code}:${index}`}>
                <strong>
                  {issue.field ? `${fieldLabels[issue.field]}: ` : ""}
                  {reasons[issue.code] ?? issue.message}
                </strong>
                <span className="small">{issue.message}</span>
                <code>{issue.code}</code>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="verification-status">
        <span
          className={`verification-dot ${artifact.verificationRecord ? "verified" : ""}`}
        />
        <div>
          <strong>
            {artifact.verificationRecord
              ? artifact.verificationRecord.source === "synthetic-fixture"
                ? "Synthetic fixture verification"
                : "Reviewer attestation recorded"
              : "Source verification required"}
          </strong>
          <p className="small muted">
            A matching OCR quotation establishes provenance. It does not
            establish document authenticity.
          </p>
        </div>
      </div>
    </>
  );
}

function ReviewPage({
  id,
  identity,
}: {
  id: string;
  identity: ReviewerIdentity;
}) {
  const detail = useResource<ReviewDetail>(`/api/reviews/${id}`, 2000);
  const evidence = useResource<Evidence>(
    `/api/applications/${id}/evidence`,
    2500,
  );
  const audit = useResource<ApplicationAudit>(
    `/api/applications/${id}/audit`,
    2000,
  );
  const [selected, setSelected] = useState<Citation | null>(null);
  const [tab, setTab] = useState<"fields" | "rules">("fields");
  const [pending, setPending] = useState<PendingCommand>();
  const [saved, setSaved] = useState(false);
  const data = detail.data;
  const artifact = evidence.data?.extraction;
  useEffect(() => {
    if (artifact && !selected)
      setSelected(
        artifact.result.fields.grossMonthlyIncomeCents.citations[0] ??
          artifact.result.fields.creditScore.citations[0] ??
          null,
      );
  }, [artifact, selected]);
  useEffect(() => {
    if (!pending || !audit.data) return;
    const persisted = audit.data.events.some(
      (event) => event.payload["commandId"] === pending.body.commandId,
    );
    const settled =
      audit.data.application.auditCommitted ||
      (audit.data.reviewCase &&
        audit.data.reviewCase.caseRevision > pending.body.caseRevision &&
        audit.data.application.status === "REVIEW");
    if (persisted && settled) {
      setPending(undefined);
      setSaved(true);
      detail.refresh();
      evidence.refresh();
    }
  }, [pending, audit.data]);
  const open =
    data?.reviewCase.status === "OPEN" && !data.application.auditCommitted;
  const decision = asDecision(data?.reviewCase.payload["decision"]);
  return (
    <>
      <a className="back-link" href="#reviews">
        ← Review queue
      </a>
      <PageHeading
        eyebrow="Human review case"
        title={`Packet ${shortId(id)}`}
        actions={
          <a className="secondary" href={`#audit/${id}`}>
            View audit
          </a>
        }
      >
        {data
          ? `Case revision ${data.reviewCase.caseRevision} · Evidence revision ${data.reviewCase.evidenceRevision} · ${data.application.policyVersion}`
          : "Inspect sources and resolve the current review"}
      </PageHeading>
      <LoadState
        loading={detail.loading}
        error={detail.error}
        retry={detail.refresh}
      />
      {data?.reviewCase.overdue && (
        <Notice type="info">
          This case is overdue and remains open. Elapsed time never decides an
          application.
        </Notice>
      )}
      {saved && !pending && (
        <Notice type="success">Review saved to the application audit.</Notice>
      )}
      {pending && (
        <Notice type="info">
          <span className="spinner" />
          Saving review. Waiting for the audited application revision.
          {pending.unconfirmed && (
            <span>
              {" "}
              Acceptance could not be confirmed. Retry the same command below
              when the service recovers.
            </span>
          )}
        </Notice>
      )}
      {data && !open && <Outcome application={data.application} />}
      <LoadState
        loading={evidence.loading}
        error={evidence.error}
        retry={evidence.refresh}
      />
      {evidence.data && artifact && (
        <div className="review-layout">
          <SourceViewer
            id={id}
            evidence={evidence.data}
            selected={selected}
            onSelect={setSelected}
          />
          <div className="review-inspection">
            <section className="panel inspection-panel">
              <div className="section-heading">
                <h2>{open ? "Review evidence" : "Saved evidence"}</h2>
                <Simulation />
              </div>
              <ValidationIssues artifact={artifact} />
              <div className="tabs" role="tablist" aria-label="Case details">
                <button
                  role="tab"
                  id="fields-tab"
                  aria-controls="fields-panel"
                  aria-selected={tab === "fields"}
                  onClick={() => setTab("fields")}
                >
                  Cited fields
                </button>
                <button
                  role="tab"
                  id="rules-tab"
                  aria-controls="rules-panel"
                  aria-selected={tab === "rules"}
                  onClick={() => setTab("rules")}
                >
                  Demo rule results
                </button>
              </div>
              {tab === "fields" ? (
                <div
                  role="tabpanel"
                  id="fields-panel"
                  aria-labelledby="fields-tab"
                >
                  <EvidenceFields
                    artifact={artifact}
                    ocr={evidence.data.ocr}
                    selected={selected}
                    onSelect={setSelected}
                  />
                </div>
              ) : (
                <div
                  role="tabpanel"
                  id="rules-panel"
                  aria-labelledby="rules-tab"
                >
                  <p className="small muted">
                    All thresholds are fictional. Evidence checks take
                    precedence over financial bands.
                  </p>
                  <RulesTable decision={decision} />
                </div>
              )}
            </section>
            {open && data && (
              <ReviewActions
                detail={data}
                artifact={artifact}
                ocr={evidence.data.ocr}
                identity={identity}
                pending={pending}
                onPending={(value) => {
                  setPending(value);
                  setSaved(false);
                }}
                onRefresh={() => {
                  detail.refresh();
                  audit.refresh();
                }}
              />
            )}
          </div>
        </div>
      )}
      {!artifact && data && !evidence.loading && !evidence.error && (
        <Notice type="info">
          Evidence artifacts are not available yet. The page will update when
          processing finishes.
        </Notice>
      )}
      {audit.error && (
        <Notice>
          Audit confirmation is unavailable: {audit.error}{" "}
          <button className="text-button" onClick={audit.refresh}>
            Retry audit
          </button>
        </Notice>
      )}
    </>
  );
}

function CorrectionEditor({
  value,
  onChange,
  ocr,
}: {
  value: RawExtraction;
  onChange: (value: RawExtraction) => void;
  ocr: OcrManifest | null;
}) {
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  function fieldChange(
    name: FieldName,
    patch: Partial<RawExtraction["fields"][FieldName]>,
  ) {
    onChange({
      ...value,
      fields: { ...value.fields, [name]: { ...value.fields[name], ...patch } },
    });
  }
  const sources =
    ocr?.pages.flatMap((page) =>
      page.blocks.map((block) => ({ page: page.pageNumber, block })),
    ) ?? [];
  function addSource(name: FieldName, key: string) {
    const source = sources.find(
      (source) => `${source.page}:${source.block.id}` === key,
    );
    if (!source) return;
    const citation: Citation = {
      page: source.page,
      blockId: source.block.id,
      quote: source.block.text,
      boundingBox: source.block.boundingBox,
    };
    const existing = value.fields[name].citations.filter(
      (item) =>
        item.page !== citation.page || item.blockId !== citation.blockId,
    );
    fieldChange(name, { citations: [...existing, citation] });
  }
  function applyJson() {
    try {
      const parsed = rawExtractionSchema.safeParse(JSON.parse(jsonText));
      if (!parsed.success) {
        setJsonError(
          parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("\n"),
        );
        return;
      }
      onChange(parsed.data);
      setJsonError("");
      setJsonMode(false);
    } catch {
      setJsonError("Enter valid extraction JSON.");
    }
  }
  return (
    <div className="correction-editor">
      <p className="small muted">
        Correct source values and attach matching OCR blocks. Amounts use the
        unit shown; every numeric value needs cited evidence. Server validation
        reruns the pinned demo policy.
      </p>
      {jsonMode ? (
        <>
          <label>
            Full cited extraction JSON
            <textarea
              className="json-editor"
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
              spellCheck={false}
              rows={20}
            />
          </label>
          {jsonError && <Notice>{jsonError}</Notice>}
          <button type="button" className="secondary" onClick={applyJson}>
            Apply JSON to correction form
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => setJsonMode(false)}
          >
            Cancel JSON edit
          </button>
        </>
      ) : (
        <>
          {fieldNames.map((name) => {
            const field = value.fields[name];
            const units =
              name === "aprBps"
                ? ["percent", "basis_points"]
                : name === "termMonths"
                  ? ["months"]
                  : name === "creditScore"
                    ? ["score"]
                    : ["USD", "cents"];
            return (
              <fieldset className="correction-field" key={name}>
                <legend>{fieldLabels[name]}</legend>
                <div className="correction-values">
                  <label>
                    Source value
                    <input
                      type="number"
                      step="any"
                      value={field.value ?? ""}
                      onChange={(event) =>
                        fieldChange(name, {
                          value:
                            event.target.value === ""
                              ? null
                              : Number(event.target.value),
                          conflictingValues: [],
                        })
                      }
                    />
                  </label>
                  <label>
                    Unit
                    <select
                      value={field.unit ?? ""}
                      onChange={(event) =>
                        fieldChange(name, {
                          unit:
                            event.target.value === ""
                              ? null
                              : (event.target.value as typeof field.unit),
                        })
                      }
                    >
                      <option value="">Not established</option>
                      {units.map((unit) => (
                        <option key={unit} value={unit}>
                          {unit === "USD"
                            ? "US dollars"
                            : unit.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Period
                    <select
                      value={field.period ?? ""}
                      onChange={(event) =>
                        fieldChange(name, {
                          period:
                            event.target.value === ""
                              ? null
                              : (event.target.value as typeof field.period),
                        })
                      }
                    >
                      <option value="">Not applicable</option>
                      {[
                        "weekly",
                        "biweekly",
                        "semimonthly",
                        "monthly",
                        "annual",
                        "unknown",
                      ].map((period) => (
                        <option key={period} value={period}>
                          {period}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="correction-citations">
                  {field.citations.map((citation, index) => (
                    <div key={`${citation.blockId}:${index}`}>
                      <span className="small">
                        Page {citation.page} · <q>{citation.quote}</q>
                      </span>
                      <button
                        type="button"
                        className="text-button"
                        aria-label={`Remove source ${index + 1} from ${fieldLabels[name]}`}
                        onClick={() =>
                          fieldChange(name, {
                            citations: field.citations.filter(
                              (_, item) => item !== index,
                            ),
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <label className="small">
                  Add a cited source
                  <select
                    value=""
                    onChange={(event) => addSource(name, event.target.value)}
                  >
                    <option value="">Choose OCR block…</option>
                    {sources.map((source) => (
                      <option
                        key={`${source.page}:${source.block.id}`}
                        value={`${source.page}:${source.block.id}`}
                      >
                        Page {source.page} · {source.block.section} ·{" "}
                        {source.block.text.slice(0, 140)}
                      </option>
                    ))}
                  </select>
                </label>
              </fieldset>
            );
          })}
          <div className="correction-flags">
            {(
              [
                "debtExcludesProposedLoan",
                "cashPriceExcludesExtras",
                "fixedApr",
              ] as const
            ).map((flag) => (
              <label key={flag}>
                {flag === "debtExcludesProposedLoan"
                  ? "Existing debts exclude the proposed loan"
                  : flag === "cashPriceExcludesExtras"
                    ? "Cash price excludes taxes, fees, and extras"
                    : "APR is fixed"}
                <select
                  value={value[flag] === null ? "unknown" : String(value[flag])}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      [flag]:
                        event.target.value === "unknown"
                          ? null
                          : event.target.value === "true",
                    })
                  }
                >
                  <option value="unknown">Not established</option>
                  <option value="true">Yes, supported by the packet</option>
                  <option value="false">No</option>
                </select>
              </label>
            ))}
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setJsonText(JSON.stringify(value, null, 2));
              setJsonMode(true);
            }}
          >
            Edit full cited extraction JSON
          </button>
        </>
      )}
    </div>
  );
}

function ReviewActions({
  detail,
  artifact,
  ocr,
  identity,
  pending,
  onPending,
  onRefresh,
}: {
  detail: ReviewDetail;
  artifact: ExtractionArtifact;
  ocr: OcrManifest | null;
  identity: ReviewerIdentity;
  pending?: PendingCommand;
  onPending: (pending: PendingCommand | undefined) => void;
  onRefresh: () => void;
}) {
  const [action, setAction] = useState<ReviewAction>("FINALIZE");
  const [decision, setDecision] = useState<"PASS" | "FAIL">("PASS");
  const [note, setNote] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [corrections, setCorrections] = useState(() =>
    correctionFromArtifact(artifact.result.fields, artifact.result.facts),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!pending)
      setCorrections(
        correctionFromArtifact(artifact.result.fields, artifact.result.facts),
      );
  }, [artifact.analysisRevision]);
  const recommendation = asDecision(detail.reviewCase.payload["decision"]);
  const evidenceReady =
    artifact.result.issues.length === 0 &&
    recommendation?.rules
      .filter((rule) => rule.id === "evidence" || rule.id === "terms")
      .every((rule) => rule.band === "PASS");
  const contradicts =
    recommendation &&
    recommendation.outcome !== "REVIEW" &&
    recommendation.outcome !== decision;
  const blockedFinalization =
    action === "FINALIZE" && (!evidenceReady || contradicts);
  async function send(body: Command) {
    setBusy(true);
    setError("");
    onPending({ body, unconfirmed: false });
    try {
      await request(`/api/reviews/${detail.application.id}/commands`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      onRefresh();
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        onPending(undefined);
        setError(
          `${error.message}${error.status === 409 ? " Reload the case before trying a new action." : ""}`,
        );
        onRefresh();
      } else {
        onPending({ body, unconfirmed: true });
        setError(
          "The review acknowledgement could not be confirmed. Your command is preserved; retry it with the same ID and content.",
        );
      }
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError("");
    if (!note.trim()) {
      setError("A reviewer note is required for every action.");
      return;
    }
    if (action === "OVERRIDE" && !acknowledged) {
      setError("Confirm the explicit educational override.");
      return;
    }
    const corrected =
      action === "CORRECT"
        ? rawExtractionSchema.safeParse(corrections)
        : undefined;
    if (corrected && !corrected.success) {
      setError(
        "The correction is incomplete. Check source values, units, periods, and citations.",
      );
      return;
    }
    const reviewCase = detail.reviewCase;
    await send({
      commandId: crypto.randomUUID(),
      applicationId: detail.application.id,
      workflowId: reviewCase.workflowId,
      workflowRunId: reviewCase.workflowRunId,
      caseRevision: reviewCase.caseRevision,
      evidenceRevision: reviewCase.evidenceRevision,
      policyVersion: reviewCase.policyVersion,
      action,
      note: note.trim(),
      ...(corrected?.success ? { corrections: corrected.data } : {}),
      ...(["FINALIZE", "OVERRIDE"].includes(action) ? { decision } : {}),
    });
  }
  const labels: Record<ReviewAction, string> = {
    FINALIZE: "Finalize simulated outcome",
    CORRECT: "Save cited corrections",
    VERIFY: "Record verification attestation",
    REQUEST_DOCUMENTS: "Request replacement packet",
    OVERRIDE: "Save educational OVERRIDE",
  };
  return (
    <section className="panel review-actions">
      <div className="section-heading">
        <h2>Reviewer action</h2>
        <span className="small muted">{identity.displayName}</span>
      </div>
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <fieldset disabled={busy || Boolean(pending)} className="action-fields">
          <label>
            Action
            <select
              aria-label="Action"
              value={action}
              onChange={(event) => {
                setAction(event.target.value as ReviewAction);
                setAcknowledged(false);
                setError("");
              }}
            >
              <option value="FINALIZE">Finalize simulated PASS / FAIL</option>
              <option value="CORRECT">
                Correct fields with cited evidence
              </option>
              <option value="VERIFY">Resolve source verification</option>
              <option value="REQUEST_DOCUMENTS">
                Request replacement documents
              </option>
              {identity.role === "override-reviewer" && (
                <option value="OVERRIDE">Explicit educational override</option>
              )}
            </select>
          </label>
          {action === "CORRECT" && (
            <CorrectionEditor
              value={corrections}
              onChange={setCorrections}
              ocr={ocr}
            />
          )}{" "}
          {action === "VERIFY" && (
            <p className="action-help">
              Record your authorized verification attestation for the supported
              numeric fields. This resolves source verification, while citation,
              confidence, and arithmetic checks still apply.
            </p>
          )}
          {action === "REQUEST_DOCUMENTS" && (
            <p className="action-help">
              Complete this attempt as NEEDS_DOCUMENTS. A replacement upload
              starts fresh OCR in a linked revision.
            </p>
          )}
          {["FINALIZE", "OVERRIDE"].includes(action) && (
            <fieldset className="decision-options">
              <legend>Educational outcome</legend>
              {(["PASS", "FAIL"] as const).map((value) => (
                <label
                  key={value}
                  className={decision === value ? "selected" : ""}
                >
                  <input
                    type="radio"
                    name="decision"
                    value={value}
                    checked={decision === value}
                    onChange={() => setDecision(value)}
                  />
                  {`Simulated ${value}`}
                </label>
              ))}
            </fieldset>
          )}
          {action === "FINALIZE" && blockedFinalization && (
            <Notice type="info">
              {!evidenceReady
                ? "Resolve evidence and loan-term issues before ordinary finalization. Correct cited fields, record verification, or request replacement documents."
                : "This outcome conflicts with the current policy recommendation. A separate authorized educational override is required."}
            </Notice>
          )}
          {action === "OVERRIDE" && (
            <div className="override-warning">
              <span className="override-label">OVERRIDE</span>
              <p>
                The original policy recommendation and all failures remain in
                the audit. This action is an explicit educational reviewer
                decision.
              </p>
              <label className="checkbox-label">
                <input
                  required
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                I am making an explicit educational override.
              </label>
            </div>
          )}
          <label>
            {action === "OVERRIDE"
              ? "Override reason (required)"
              : "Reviewer note (required)"}
            <textarea
              required
              maxLength={4000}
              rows={4}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder={
                action === "CORRECT"
                  ? "Explain what changed and which source supports the correction."
                  : action === "OVERRIDE"
                    ? "Explain why you are overriding the demo recommendation."
                    : "Explain your review and the basis for this action."
              }
            />
          </label>
          <div className="action-submit">
            <Simulation />
            <button
              className={action === "OVERRIDE" ? "override-button" : "primary"}
              disabled={
                blockedFinalization ||
                (action === "OVERRIDE" && !acknowledged) ||
                !note.trim()
              }
            >
              {busy ? "Submitting…" : labels[action]}
            </button>
          </div>
        </fieldset>
        {error && <Notice>{error}</Notice>}
        {pending?.unconfirmed && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              void send(pending.body);
            }}
          >
            {busy ? "Retrying…" : "Retry preserved review command"}
          </button>
        )}
        {pending && (
          <p className="small muted">
            Saving review · Command <code>{pending.body.commandId}</code>
          </p>
        )}
      </form>
    </section>
  );
}

function IdentityDetails({
  application,
}: {
  application: ApplicationProjection;
}) {
  return (
    <dl className="identity-details">
      <div>
        <dt>Application ID</dt>
        <dd>
          <code>{application.id}</code>
        </dd>
      </div>
      <div>
        <dt>Document SHA-256</dt>
        <dd>
          <code>{application.documentHash}</code>
        </dd>
      </div>
      <div>
        <dt>Policy snapshot</dt>
        <dd>
          {application.policyVersion}
          <code>{application.policyHash}</code>
        </dd>
      </div>
      <div>
        <dt>Workflow ID</dt>
        <dd>
          <code>{application.workflowId}</code>
        </dd>
      </div>
      <div>
        <dt>Workflow run ID</dt>
        <dd>
          <code>{application.workflowRunId ?? "Not started"}</code>
        </dd>
      </div>
      <div>
        <dt>Application / evidence revision</dt>
        <dd>
          {application.revision} / {application.evidenceRevision}
        </dd>
      </div>
      <div>
        <dt>Mode / audit persistence</dt>
        <dd>
          {application.mode} /{" "}
          {application.auditCommitted ? "Final audit committed" : "In progress"}
        </dd>
      </div>
    </dl>
  );
}

const eventNames: Record<string, string> = {
  APPLICATION_UPLOADED: "Packet received",
  UPLOADED: "Packet received",
  OCR_COMPLETED: "Pages rendered and OCR completed",
  EXTRACTION_COMPLETED: "Cited evidence extracted",
  POLICY_EVALUATED: "Pinned demo rules evaluated",
  REVIEW_OPENED: "Human review opened",
  REVIEW_OVERDUE: "Review marked overdue",
  REVIEW_COMMAND: "Reviewer action recorded",
  EVIDENCE_CORRECTED: "Cited evidence corrected",
  REVIEW_OVERRIDE: "Educational override recorded",
  FINAL_COMMITTED: "Final outcome and audit committed",
  REVIEW_COMMAND_REJECTED: "Review command rejected",
  REVIEW_UPDATE_ACKNOWLEDGEMENT_UNCONFIRMED:
    "Review acknowledgement unconfirmed",
  PROCESSING_RECOVERY: "Processing recovery recorded",
};
function AuditPage({ id }: { id: string }) {
  const audit = useResource<ApplicationAudit>(
    `/api/applications/${id}/audit`,
    2500,
  );
  const evidence = useResource<Evidence>(
    `/api/applications/${id}/evidence`,
    3000,
  );
  const [selected, setSelected] = useState<Citation | null>(null);
  const data = audit.data;
  const application = data?.application;
  const decision =
    asDecision(application?.data["finalDecision"]) ??
    asDecision(data?.reviewCase?.payload["decision"]) ??
    asDecision(
      [...(data?.events ?? [])]
        .reverse()
        .find((event) => event.payload["decision"])?.payload["decision"],
    );
  const original =
    asDecision(application?.data["originalRecommendation"]) ??
    asDecision(data?.reviewCase?.payload["originalRecommendation"]) ??
    asDecision(
      data?.events.find((event) => event.type === "POLICY_EVALUATED")?.payload[
        "decision"
      ],
    );
  const artifact = evidence.data?.extraction;
  return (
    <>
      <a className="back-link" href={`#applications/${id}`}>
        ← Application status
      </a>
      <PageHeading
        eyebrow="Application audit"
        title={`The record for packet ${shortId(id)}`}
        actions={
          <a
            className="secondary"
            href={`/api/applications/${id}/audit?download=1`}
            download
          >
            Download audit JSON ↓
          </a>
        }
      >
        Source evidence, pinned rules, reviewer actions, and the committed
        simulated outcome.
      </PageHeading>
      <LoadState
        loading={audit.loading}
        error={audit.error}
        retry={audit.refresh}
      />
      {application && (
        <>
          <Outcome application={application} />
          <section className="panel audit-context">
            <div className="section-heading">
              <h2>Decision record</h2>
              <span className="mode-text">{application.mode} mode</span>
            </div>
            <dl className="decision-context">
              <div>
                <dt>Original recommendation</dt>
                <dd>
                  {original ? (
                    <Badge status={original.outcome} />
                  ) : (
                    "Pending evaluation"
                  )}
                </dd>
              </div>
              <div>
                <dt>Current / final outcome</dt>
                <dd>
                  {decision ? (
                    <Badge status={decision.outcome} />
                  ) : (
                    "Not evaluated"
                  )}
                </dd>
              </div>
              <div>
                <dt>Decision authority</dt>
                <dd>
                  {textValue(application.data["decisionAuthority"]).replaceAll(
                    "-",
                    " ",
                  ) || "Awaiting review"}
                </dd>
              </div>
              <div>
                <dt>Final persistence</dt>
                <dd>
                  {application.auditCommitted
                    ? "Audit and outcome committed together"
                    : "In progress"}
                </dd>
              </div>
            </dl>
            <details>
              <summary>
                Source hashes, policy snapshot, and execution identity
              </summary>
              <IdentityDetails application={application} />
              {artifact && (
                <dl className="identity-details">
                  <div>
                    <dt>OCR artifact SHA-256 / version</dt>
                    <dd>
                      <code>{artifact.ocrArtifactHash}</code>
                      {artifact.ocrVersion}
                    </dd>
                  </div>
                  <div>
                    <dt>Extraction prompt SHA-256 / version</dt>
                    <dd>
                      <code>{artifact.promptHash}</code>
                      {artifact.promptVersion}
                    </dd>
                  </div>
                  <div>
                    <dt>Model / provider request ID</dt>
                    <dd>
                      {artifact.modelId}
                      <code>
                        {artifact.providerRequestId ?? "Not supplied"}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>Observable extraction attempts</dt>
                    <dd>
                      {artifact.attempts.map((attempt, index) => (
                        <span key={index}>
                          {attempt.kind.replaceAll("_", " ")}:{" "}
                          {attempt.succeeded
                            ? "succeeded"
                            : (attempt.errorCode ?? "failed")}
                          <br />
                        </span>
                      ))}
                    </dd>
                  </div>
                </dl>
              )}
            </details>
          </section>
          <section className="panel audit-rules">
            <div className="section-heading">
              <h2>Rule results</h2>
              <span className="small muted">{application.policyVersion}</span>
            </div>
            <RulesTable decision={decision} />
            {application.data["override"] === true && (
              <Notice type="info">
                <strong>OVERRIDE:</strong> The final simulated outcome was
                chosen by an authorized reviewer. The original policy
                recommendation and failures remain below and in the JSON export.
              </Notice>
            )}
          </section>
          {data && (
            <section className="panel audit-timeline">
              <div className="section-heading">
                <h2>Application timeline</h2>
                <span className="small muted">
                  {data.events.length} persisted events
                </span>
              </div>
              <ol className="timeline">
                {data.events.map((event) => (
                  <li key={event.eventId}>
                    <span className="timeline-marker" />
                    <div className="timeline-heading">
                      <h3>
                        {eventNames[event.type] ??
                          event.type.replaceAll("_", " ").toLowerCase()}
                      </h3>
                      <time dateTime={event.timestamp}>
                        {time(event.timestamp)}
                      </time>
                    </div>
                    <p className="small muted">
                      {event.actorType}
                      {event.actorId ? ` · ${event.actorId}` : ""} · Event{" "}
                      {event.sequence}
                      {event.evidenceRevision
                        ? ` · Evidence ${event.evidenceRevision}`
                        : ""}
                    </p>
                    {event.payload["override"] === true && (
                      <span className="override-label">OVERRIDE</span>
                    )}
                    {textValue(event.payload["note"]) && (
                      <blockquote className="audit-note">
                        {textValue(event.payload["note"])}
                      </blockquote>
                    )}
                    <ReasonList codes={event.reasonCodes} />
                    {event.payload["originalFacts"] &&
                    event.payload["correctedFacts"] ? (
                      <FactChanges
                        before={event.payload["originalFacts"]}
                        after={event.payload["correctedFacts"]}
                      />
                    ) : null}
                    <details className="event-details">
                      <summary>Event identifiers and observable record</summary>
                      <pre>{JSON.stringify(event, null, 2)}</pre>
                    </details>
                  </li>
                ))}
              </ol>
              {data.commands.length > 0 && (
                <details className="command-history">
                  <summary>
                    {data.commands.length} review commands and API acceptance
                    records
                  </summary>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Command / reviewer</th>
                          <th>Action</th>
                          <th>Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.commands.map((command) => (
                          <tr key={command.commandId}>
                            <td>
                              <code>{command.commandId}</code>
                              <span className="table-subtitle">
                                {command.reviewerId} · {time(command.createdAt)}
                              </span>
                            </td>
                            <td>
                              {textValue(
                                (
                                  command.payload as
                                    | Record<string, unknown>
                                    | undefined
                                )?.["action"],
                              )}
                            </td>
                            <td>
                              {command.status} · HTTP {command.statusCode}
                              <span className="table-subtitle">
                                {textValue(command.result?.["code"])}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </section>
          )}
          <LoadState
            loading={evidence.loading}
            error={evidence.error}
            retry={evidence.refresh}
          />
          {evidence.data && artifact && (
            <section className="audit-evidence">
              <div className="section-heading">
                <h2>What the system read</h2>
                <span className="small muted">
                  Saved evidence · revision {application.evidenceRevision}
                </span>
              </div>
              <div className="review-layout">
                <SourceViewer
                  id={id}
                  evidence={evidence.data}
                  selected={selected}
                  onSelect={setSelected}
                />
                <section className="panel inspection-panel">
                  <ValidationIssues artifact={artifact} />
                  <EvidenceFields
                    artifact={artifact}
                    ocr={evidence.data.ocr}
                    selected={selected}
                    onSelect={setSelected}
                  />
                </section>
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

function FactChanges({ before, after }: { before: unknown; after: unknown }) {
  if (
    !before ||
    !after ||
    typeof before !== "object" ||
    typeof after !== "object"
  )
    return null;
  const initial = before as Record<string, unknown>;
  const corrected = after as Record<string, unknown>;
  const changes = fieldNames.filter(
    (name) => initial[name] !== corrected[name],
  );
  return changes.length ? (
    <dl className="fact-changes">
      {changes.map((name) => (
        <div key={name}>
          <dt>{fieldLabels[name]}</dt>
          <dd>
            {formatFact(
              name,
              typeof initial[name] === "number"
                ? (initial[name] as number)
                : null,
            )}{" "}
            →{" "}
            <strong>
              {formatFact(
                name,
                typeof corrected[name] === "number"
                  ? (corrected[name] as number)
                  : null,
              )}
            </strong>
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <p className="small muted">
      Numeric facts unchanged; verification or cited evidence was updated.
    </p>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
