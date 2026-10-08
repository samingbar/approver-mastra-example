import { describe, expect, it } from "vitest";
import type { ApplicationProjection } from "../src/storage.js";
import type { Citation, OcrManifest } from "../src/contracts.js";
import {
  citationConfidence,
  visibleStatus,
  withWorkflowProgress,
} from "../ui/presentation.js";

describe("GUI outcome and source confidence safety", () => {
  it("shows audit persistence progress from the workflow Query without publishing an uncommitted outcome", () => {
    const pending = {
      status: "REVIEW",
      stage: "awaiting review",
      auditCommitted: false,
    } as ApplicationProjection;
    expect(
      visibleStatus(
        withWorkflowProgress(pending, {
          status: "AUDIT_PENDING",
          stage: "final audit",
        }),
      ),
    ).toBe("AUDIT_PENDING");
    expect(
      visibleStatus(
        withWorkflowProgress(pending, { status: "PASS", stage: "complete" }),
      ),
    ).toBe("AUDIT_PENDING");
    expect(
      visibleStatus(
        withWorkflowProgress(
          { ...pending, status: "PASS", auditCommitted: true },
          { status: "REVIEW", stage: "old progress" },
        ),
      ),
    ).toBe("PASS");
  });
  it("keeps all terminal projections pending until their final audit is committed", () => {
    for (const status of [
      "PASS",
      "FAIL",
      "NEEDS_DOCUMENTS",
      "INPUT_ERROR",
      "PROCESSING_ERROR",
      "CANCELLED",
    ]) {
      expect(
        visibleStatus({
          status,
          auditCommitted: false,
        } as ApplicationProjection),
      ).toBe("AUDIT_PENDING");
      expect(
        visibleStatus({
          status,
          auditCommitted: true,
        } as ApplicationProjection),
      ).toBe(status);
    }
    expect(
      visibleStatus({
        status: "REVIEW",
        auditCommitted: false,
      } as ApplicationProjection),
    ).toBe("REVIEW");
  });

  const box = { x: 20, y: 40, width: 100, height: 15 };
  const citation: Citation = {
    page: 2,
    blockId: "income-1",
    quote: "Income $5,000 monthly",
    boundingBox: box,
  };
  function manifest(confidence: number | null): OcrManifest {
    return {
      documentHash: "0".repeat(64),
      ocrVersion: "test-ocr",
      engineVersion: "test",
      qualityFlags: [],
      pages: [
        {
          pageNumber: 2,
          width: 1000,
          height: 1400,
          imageRef: {
            key: "page.png",
            sha256: "0".repeat(64),
            contentType: "image/png",
            size: 1,
          },
          pageHash: "0".repeat(64),
          engineVersion: "test",
          blocks: [
            {
              id: "income-1",
              text: citation.quote,
              boundingBox: box,
              confidence: 95,
              section: "income",
              tokens: [
                { text: "Income", confidence: 40 },
                { text: "$5,000", confidence },
                { text: "monthly", confidence: 99 },
              ],
            },
          ],
        },
      ],
    };
  }

  it("shows numeric token confidence rather than a high block average or unrelated text confidence", () => {
    expect(citationConfidence(citation, manifest(72))).toBe(72);
    expect(citationConfidence(citation, manifest(96))).toBe(96);
  });
  it("does not invent confidence for unavailable numeric tokens or absent citations", () => {
    expect(citationConfidence(citation, manifest(null))).toBeNull();
    expect(
      citationConfidence({ ...citation, blockId: "absent" }, manifest(96)),
    ).toBeNull();
  });
});
