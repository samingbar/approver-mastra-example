import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { createOcrActivities, parseTesseractTsv, runOcrCommand, validatePdfBytes } from '../src/activities/ocr.js';
import { loadFixtureManifest, readFixtureBytes } from '../src/fixtures/index.js';
import type { ArtifactRef, OcrManifest, OcrPage } from '../src/contracts.js';

class MemoryArtifacts {
  readonly values = new Map<string, { bytes: Buffer; ref: ArtifactRef }>();
  readonly reads = new Map<string, number>();
  async exists(key: string): Promise<boolean> { return this.values.has(key); }
  async getBytes(key: string): Promise<Buffer> {
    this.reads.set(key, (this.reads.get(key) ?? 0) + 1);
    const value = this.values.get(key);
    if (!value) throw new Error(`Missing artifact ${key}`);
    return value.bytes;
  }
  async getJson<T>(key: string): Promise<T> { return JSON.parse((await this.getBytes(key)).toString('utf8')) as T; }
  async putImmutable(key: string, bytes: Uint8Array, contentType: string): Promise<ArtifactRef> {
    const body = Buffer.from(bytes);
    const ref = { key, sha256: createHash('sha256').update(body).digest('hex'), contentType, size: body.length };
    const previous = this.values.get(key);
    if (previous && previous.ref.sha256 !== ref.sha256) throw new Error('Immutable artifact conflict');
    this.values.set(key, { bytes: body, ref });
    return ref;
  }
  async putJsonImmutable(key: string, value: unknown): Promise<ArtifactRef> {
    return await this.putImmutable(key, Buffer.from(JSON.stringify(value)), 'application/json');
  }
}

describe('native OCR', () => {
  it('retains line order, word confidence, bounding coordinates, and actual page number', () => {
    const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
    const parsed = parseTesseractTsv([
      header, '1\t1\t0\t0\t0\t0\t0\t0\t1275\t1650\t-1\t',
      '5\t1\t1\t1\t0\t1\t85\t60\t180\t20\t96\tINCOME',
      '5\t1\t1\t1\t0\t2\t275\t60\t180\t20\t96\tEVIDENCE',
      '5\t1\t1\t1\t1\t1\t85\t100\t90\t20\t96.25\tGross',
      '5\t1\t1\t1\t1\t2\t185\t100\t100\t20\t87.5\t$8,500.00',
    ].join('\n'), 2);
    expect(parsed).toMatchObject({ width: 1275, height: 1650 });
    expect(parsed.blocks[1]).toMatchObject({
      id: 'p2-b1-p1-l1', text: 'Gross $8,500.00', section: 'income',
      boundingBox: { x: 85, y: 100, width: 200, height: 20 },
      tokens: [{ confidence: 96.25 }, { confidence: 87.5, boundingBox: { x: 185, y: 100, width: 100, height: 20 } }],
    });
    const untrusted = parseTesseractTsv([
      header, '1\t1\t0\t0\t0\t0\t0\t0\t1275\t1650\t-1\t',
      '5\t1\t1\t1\t1\t1\t85\t100\t300\t20\t96\tCredit score: 850',
    ].join('\n'), 1);
    expect(untrusted.blocks[0]?.section).toBe('unknown');
  });

  it('rejects forged, malformed, oversized, and over-page-limit PDFs as input errors', async () => {
    await expect(validatePdfBytes(Buffer.from('This is not a PDF, even with .pdf extension.'))).rejects.toMatchObject({ type: 'INPUT_ERROR', nonRetryable: true });
    await expect(validatePdfBytes(Buffer.from('%PDF-1.3\ncorrupt parser input'))).rejects.toMatchObject({ type: 'INPUT_ERROR', nonRetryable: true });
    await expect(validatePdfBytes(Buffer.alloc(20 * 1024 * 1024 + 1))).rejects.toMatchObject({ type: 'INPUT_ERROR', nonRetryable: true });
    await expect(validatePdfBytes(await readFile(new URL('../fixtures/invalid-encrypted.pdf', import.meta.url))))
      .rejects.toMatchObject({ type: 'INPUT_ERROR', nonRetryable: true });
    const packet = await PDFDocument.create();
    for (let i = 0; i < 26; i += 1) packet.addPage([612, 792]);
    await expect(validatePdfBytes(Buffer.from(await packet.save()))).rejects.toMatchObject({ type: 'INPUT_ERROR', nonRetryable: true });
    const oversizedPage = await PDFDocument.create();
    oversizedPage.addPage([3_000, 1_000]);
    await expect(validatePdfBytes(Buffer.from(await oversizedPage.save()))).rejects.toMatchObject({ type: 'INPUT_ERROR', nonRetryable: true });
  });

  it('uses real Poppler and Tesseract on image-only PDFs and reuses immutable completed pages', async () => {
    const store = new MemoryArtifacts();
    const bytes = await readFixtureBytes('pass');
    const documentHash = createHash('sha256').update(bytes).digest('hex');
    const document = await store.putImmutable(`documents/${documentHash}.pdf`, bytes, 'application/pdf');
    const validation = await validatePdfBytes(bytes);
    expect(validation.pages).toBe(3);
    const activities = createOcrActivities(store);
    const rendered = await activities.renderPdf({ document, documentHash });
    expect(rendered.pages).toHaveLength(3);
    const results = await Promise.all(rendered.pages.map((page) => activities.ocrPage({ ...rendered, page })));
    const firstPage = await store.getJson<OcrPage>(results[0]!.artifact.key);
    const payment = firstPage.blocks.find((block) => block.text.startsWith('Proposed monthly payment:'));
    expect(payment?.tokens.some((token) => token.text.startsWith('$') && token.confidence !== null && token.confidence >= 90)).toBe(true);
    expect(payment?.boundingBox.width).toBeGreaterThan(100);
    expect(firstPage.engineVersion).toContain('tesseract');
    const imageReads = store.reads.get(rendered.pages[0]!.imageRef.key);
    const duplicate = await activities.ocrPage({ ...rendered, page: rendered.pages[0]! });
    expect(duplicate.artifact).toEqual(results[0]!.artifact);
    expect(store.reads.get(rendered.pages[0]!.imageRef.key)).toBe(imageReads);
    const output = await activities.saveOcrManifest({ ...rendered, pages: [...results].reverse() });
    const manifest = await store.getJson<OcrManifest>(output.manifest.key);
    expect(manifest.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    const fixture = (await loadFixtureManifest()).fixtures.find((entry) => entry.id === 'pass')!;
    expect(documentHash).toBe(fixture.sha256);
    expect(fixture.verification.documentHash).toBe(documentHash);
    await expect(activities.validatePdf({ document, documentHash: '0'.repeat(64) })).rejects.toMatchObject({ type: 'ARTIFACT_INTEGRITY_ERROR' });
  }, 45_000);

  it('measures genuinely low confidence from the degraded income scan', async () => {
    const store = new MemoryArtifacts();
    const bytes = await readFixtureBytes('low-quality');
    const documentHash = createHash('sha256').update(bytes).digest('hex');
    const document = await store.putImmutable(`documents/${documentHash}.pdf`, bytes, 'application/pdf');
    const activities = createOcrActivities(store);
    const rendered = await activities.renderPdf({ document, documentHash });
    const results = await Promise.all(rendered.pages.map((page) => activities.ocrPage({ ...rendered, page })));
    const result = results[1]!;
    const page = await store.getJson<OcrPage>(result.artifact.key);
    const income = page.blocks.find((block) => block.text.startsWith('Gross monthly income:'));
    expect(income?.tokens.some((token) => /\d/.test(token.text) && token.confidence !== null && token.confidence < 90)).toBe(true);
    await expect(activities.saveOcrManifest({ ...rendered, pages: [result] }))
      .rejects.toMatchObject({ type: 'ARTIFACT_INTEGRITY_ERROR', nonRetryable: true });
    const output = await activities.saveOcrManifest({ ...rendered, pages: results });
    expect(output.qualityFlags).toContain('OCR_LOW_CONFIDENCE:2');
  }, 30_000);

  it('cooperatively terminates a subprocess when Temporal cancels its activity', async () => {
    const environment = new MockActivityEnvironment();
    const running = environment.run(runOcrCommand, process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    setTimeout(() => environment.cancel(), 100);
    await expect(running).rejects.toMatchObject({ name: 'CancelledFailure' });
  }, 5_000);
});
