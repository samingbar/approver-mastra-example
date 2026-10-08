import { ActivityCancellationType, proxyActivities } from '@temporalio/workflow';
import type { OcrActivities, OcrDocumentInput, OcrPageResult, OcrResult } from '../activities/ocr.js';

const render = proxyActivities<Pick<OcrActivities, 'renderPdf'>>({
  startToCloseTimeout: '15 minutes', scheduleToCloseTimeout: '30 minutes', heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 5 },
});
const pages = proxyActivities<Pick<OcrActivities, 'ocrPage'>>({
  startToCloseTimeout: '2 minutes', scheduleToCloseTimeout: '10 minutes', heartbeatTimeout: '30 seconds',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 5 },
});
const manifests = proxyActivities<Pick<OcrActivities, 'saveOcrManifest'>>({
  startToCloseTimeout: '1 minute', scheduleToCloseTimeout: '10 minutes',
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds', maximumAttempts: 5 },
});

/** Native Temporal child: history contains immutable references, never PDFs or OCR text. */
export async function ocrDocumentWorkflow(input: OcrDocumentInput): Promise<OcrResult> {
  const rendered = await render.renderPdf(input);
  const results: OcrPageResult[] = [];
  // Four pages per document at most; the OCR worker also caps its global activity slots.
  for (let offset = 0; offset < rendered.pages.length; offset += 4) {
    results.push(...await Promise.all(rendered.pages.slice(offset, offset + 4).map((page) => pages.ocrPage({
      documentHash: rendered.documentHash, ocrVersion: rendered.ocrVersion,
      engineVersion: rendered.engineVersion, page,
    }))));
  }
  return await manifests.saveOcrManifest({
    documentHash: rendered.documentHash, ocrVersion: rendered.ocrVersion,
    engineVersion: rendered.engineVersion, pages: results,
  });
}
