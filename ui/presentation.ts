import type { ApplicationProjection } from "../src/storage.js";
import type {
  Citation,
  FieldName,
  OcrManifest,
  PolicyDecision,
  RawExtraction,
} from "../src/contracts.js";
import type { ApplicationState } from "../src/workflows/application-contract.js";

export const fieldLabels: Record<FieldName, string> = {
  grossMonthlyIncomeCents: "Gross monthly income",
  existingMonthlyDebtCents: "Existing monthly debt",
  financedAmountCents: "Financed amount",
  vehicleCashPriceCents: "Vehicle cash price",
  proposedMonthlyPaymentCents: "Proposed monthly payment",
  termMonths: "Loan term",
  aprBps: "Fixed APR",
  creditScore: "Credit score",
};

export const reasons: Record<string, string> = {
  SCHEMA_INVALID:
    "The extracted information does not match the supported format.",
  EVIDENCE_MISSING: "Required information is missing from the packet.",
  EVIDENCE_AMBIGUOUS: "A source value is ambiguous.",
  EVIDENCE_CONFLICT: "Source figures disagree and need review.",
  CITATION_INVALID: "A citation could not be verified against the OCR text.",
  SOURCE_SECTION_INVALID:
    "A value is cited from an unexpected document section.",
  NORMALIZATION_INVALID: "A source value could not be converted consistently.",
  OCR_LOW_CONFIDENCE: "Cited numeric text is below 90% OCR confidence.",
  OCR_CONFIDENCE_MISSING:
    "OCR confidence is unavailable for a cited numeric value.",
  VERIFICATION_REQUIRED:
    "The source evidence needs an authorized verification attestation.",
  UNSUPPORTED_PERIOD: "A payment or income period is unsupported.",
  INPUT_BUDGET_EXCEEDED: "The packet exceeds the bounded extraction budget.",
  DOMAIN_INVALID:
    "A required value is missing, zero, negative, or outside its valid range.",
  DEBT_DOUBLE_COUNTING:
    "Confirm that existing debts exclude the proposed loan payment.",
  CASH_PRICE_AMBIGUOUS:
    "Confirm that cash price excludes taxes, fees, and optional products.",
  UNSUPPORTED_TERMS: "Loan terms fall outside the supported demo calculation.",
  PAYMENT_MISMATCH:
    "The proposed payment differs from the computed payment by more than $1.",
  CREDIT_BELOW_MINIMUM:
    "Credit score is below the fictional demo minimum of 640.",
  CREDIT_BORDERLINE: "Credit score is in the demo review band of 640–699.",
  DTI_ABOVE_MAXIMUM:
    "Debt-to-income exceeds the fictional demo maximum of 45%.",
  DTI_BORDERLINE: "Debt-to-income is above 36% and at or below 45%.",
  LTV_ABOVE_MAXIMUM:
    "Loan-to-value exceeds the fictional demo maximum of 110%.",
  LTV_BORDERLINE: "Loan-to-value is above 100% and at or below 110%.",
};

const committedStatuses = new Set([
  "PASS",
  "FAIL",
  "NEEDS_DOCUMENTS",
  "INPUT_ERROR",
  "PROCESSING_ERROR",
  "CANCELLED",
]);

/** A projection is only a final outcome after the atomic audit commit. */
export function visibleStatus(application: ApplicationProjection): string {
  return committedStatuses.has(application.status) &&
    !application.auditCommitted
    ? "AUDIT_PENDING"
    : application.status;
}

/** A workflow Query describes progress; the committed projection owns outcomes. */
export function withWorkflowProgress(
  application: ApplicationProjection,
  state?: Pick<ApplicationState, "status" | "stage"> | null,
): ApplicationProjection {
  return application.auditCommitted || !state
    ? application
    : { ...application, status: state.status, stage: state.stage };
}

export function statusLabel(status: string): string {
  return (
    (
      {
        UPLOADED: "Packet received",
        OCR: "Reading document",
        EXTRACTING: "Extracting evidence",
        EVALUATING: "Checking demo rules",
        REVIEW: "Needs human review",
        SAVING: "Saving review",
        AUDIT_PENDING: "Saving audit",
        PASS: "Simulated PASS",
        FAIL: "Simulated FAIL",
        NEEDS_DOCUMENTS: "Replacement packet requested",
        INPUT_ERROR: "Invalid packet",
        PROCESSING_ERROR: "Processing error",
        CANCELLED: "Cancelled",
        NOT_EVALUATED: "Not evaluated",
      } as Record<string, string>
    )[status] ?? status.replaceAll("_", " ").toLowerCase()
  );
}

export function formatFact(name: FieldName, value: number | null): string {
  if (value === null) return "Not established";
  if (name.endsWith("Cents"))
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value / 100);
  if (name === "aprBps") return `${(value / 100).toFixed(2)}%`;
  if (name === "termMonths") return `${value} months`;
  return String(value);
}

export function asDecision(value: unknown): PolicyDecision | undefined {
  if (!value || typeof value !== "object") return undefined;
  const decision = value as Partial<PolicyDecision>;
  return Array.isArray(decision.rules) && typeof decision.outcome === "string"
    ? (decision as PolicyDecision)
    : undefined;
}

export function citationConfidence(
  citation: Citation,
  manifest: OcrManifest,
): number | null {
  const block = manifest.pages
    .find((page) => page.pageNumber === citation.page)
    ?.blocks.find((block) => block.id === citation.blockId);
  if (!block) return null;
  const tokens = block.tokens.filter((token) => /\d/.test(token.text));
  if (!tokens.length || tokens.some((token) => token.confidence === null))
    return null;
  return Math.min(...tokens.map((token) => token.confidence!));
}

export function correctionFromArtifact(
  fields: RawExtraction["fields"],
  facts: {
    debtExcludesProposedLoan: boolean | null;
    cashPriceExcludesExtras: boolean | null;
    fixedApr: boolean | null;
  },
): RawExtraction {
  return {
    fields: structuredClone(fields),
    debtExcludesProposedLoan: facts.debtExcludesProposedLoan,
    cashPriceExcludesExtras: facts.cashPriceExcludesExtras,
    fixedApr: facts.fixedApr,
    notes: [],
  };
}
