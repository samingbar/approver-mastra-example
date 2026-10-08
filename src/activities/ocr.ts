import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Context } from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import {
  ocrManifestSchema, ocrPageSchema, type ArtifactRef, type BoundingBox,
  type DocumentSection, type OcrBlock, type OcrManifest,
} from '../contracts.js';
import type { ArtifactStore } from '../storage.js';

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 25;
export const OCR_DPI = 150;
export const DEFAULT_OCR_VERSION = 'ocr-v1-eng-dpi150';
const COMMAND_TIMEOUT_MS = 110_000;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
type OcrStore = Pick<ArtifactStore, 'getBytes' | 'getJson' | 'putImmutable' | 'putJsonImmutable' | 'exists'>;

export interface OcrDocumentInput {
  document: ArtifactRef;
  documentHash: string;
  ocrVersion?: string;
}

export interface RenderedPage {
  pageNumber: number;
  width: number;
  height: number;
  imageRef: ArtifactRef;
  pageHash: string;
}

export interface RenderResult {
  documentHash: string;
  ocrVersion: string;
  engineVersion: string;
  pages: RenderedPage[];
}

export interface OcrPageInput {
  documentHash: string;
  ocrVersion: string;
  engineVersion: string;
  page: RenderedPage;
}

export interface OcrPageResult { pageNumber: number; artifact: ArtifactRef }
export interface OcrResult { manifest: ArtifactRef; qualityFlags: string[] }
export interface PdfValidation { pages: number; size: number; sha256: string }

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function inputError(message: string): never {
  throw ApplicationFailure.nonRetryable(message, 'INPUT_ERROR', { action: 'resubmit_pdf' });
}

function artifactKey(documentHash: string, version: string, page: number, kind: 'renders' | 'ocr'): string {
  if (!/^[a-f0-9]{64}$/.test(documentHash) || !/^[a-zA-Z0-9._-]{1,120}$/.test(version)) {
    inputError('Invalid immutable document or OCR version reference.');
  }
  return `${kind}/${documentHash}/${version}/page-${String(page).padStart(3, '0')}.${kind === 'renders' ? 'png' : 'json'}`;
}

function activityContext(): Context | undefined {
  try { return Context.current(); } catch { return undefined; }
}

/** Cooperative cancellation, bounded output, and a deadline shorter than the activity timeout. */
export async function runOcrCommand(command: string, args: string[], checkpoint: Record<string, unknown> = {}): Promise<string> {
  const context = activityContext();
  const signal = context?.cancellationSignal;
  if (signal?.aborted) throw new CancelledFailure('OCR activity cancelled.');
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OMP_THREAD_LIMIT: '1' } });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    function stop(error: Error): void {
      if (failure) return;
      failure = error;
      child.kill('SIGTERM');
      hardKill = setTimeout(() => child.kill('SIGKILL'), 250);
      hardKill.unref();
    }
    const abort = (): void => stop(new CancelledFailure('OCR activity cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => stop(new Error(`OCR executable exceeded ${COMMAND_TIMEOUT_MS}ms deadline.`)), COMMAND_TIMEOUT_MS);
    const heartbeats = setInterval(() => {
      try { context?.heartbeat(checkpoint); } catch (error) { stop(error instanceof Error ? error : new Error('OCR heartbeat failed.')); }
    }, 5_000);
    function collect(target: Buffer[], chunk: Buffer): void {
      bytes += chunk.length;
      if (bytes > MAX_COMMAND_OUTPUT_BYTES) stop(new Error('OCR executable exceeded output limit.'));
      else target.push(chunk);
    }
    child.stdout.on('data', (chunk: Buffer) => collect(output, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(errors, chunk));
    function cleanup(): void {
      clearTimeout(deadline);
      clearInterval(heartbeats);
      if (hardKill) clearTimeout(hardKill);
      signal?.removeEventListener('abort', abort);
    }
    child.once('error', (error: NodeJS.ErrnoException) => {
      cleanup();
      reject(error.code === 'ENOENT'
        ? ApplicationFailure.nonRetryable(`Required OCR executable is not installed: ${command}.`, 'OCR_CONFIGURATION_ERROR')
        : error);
    });
    child.once('close', (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} exited ${String(code)}: ${Buffer.concat(errors).toString('utf8').slice(0, 600)}`));
      else resolve(Buffer.concat(output).toString('utf8') || Buffer.concat(errors).toString('utf8'));
    });
  });
}

/** Validate bytes, actual PDF parser acceptance, encryption, page count, and bounded page geometry. */
export async function validatePdfBytes(bytes: Buffer): Promise<PdfValidation> {
  if (bytes.length === 0 || bytes.length > MAX_PDF_BYTES) inputError('Upload must be a PDF of at most 20 MiB.');
  if (!/%PDF-\d\.\d/.test(bytes.subarray(0, Math.min(bytes.length, 1024)).toString('latin1'))) {
    inputError('The uploaded file is not a supported PDF.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'loan-pdf-'));
  try {
    const path = join(directory, 'packet.pdf');
    await writeFile(path, bytes);
    let info: string;
    try { info = await runOcrCommand('pdfinfo', ['-box', '-f', '1', '-l', String(MAX_PDF_PAGES), path]); }
    catch (error) {
      if (error instanceof CancelledFailure) throw error;
      if (error instanceof ApplicationFailure && error.type === 'OCR_CONFIGURATION_ERROR') throw error;
      // A missing executable is operator configuration, never a bad applicant packet.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw ApplicationFailure.nonRetryable('PDF renderer executable is not installed.', 'OCR_CONFIGURATION_ERROR');
      }
      inputError('PDF is malformed, encrypted, or unsupported. Submit a non-password-protected PDF.');
    }
    if (/^Encrypted:\s+yes/im.test(info)) inputError('Password-protected PDFs are unsupported. Submit an unencrypted PDF.');
    const pages = Number(/^Pages:\s+(\d+)/im.exec(info)?.[1]);
    if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PDF_PAGES) inputError('PDF must have between 1 and 25 pages.');
    const sizes = [...info.matchAll(/(?:Page\s+(?:\d+\s+)?size|Page size):\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gi)];
    for (const size of sizes) {
      const width = Number(size[1]);
      const height = Number(size[2]);
      if (width <= 0 || height <= 0 || width > 2_000 || height > 2_000 || width * height * (OCR_DPI / 72) ** 2 > 12_000_000) {
        inputError('PDF page geometry exceeds the supported demo rendering bounds.');
      }
    }
    return { pages, size: bytes.length, sha256: sha256(bytes) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.length < 24) {
    throw new Error('Renderer did not return a PNG image.');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function sectionFor(text: string, fallback: DocumentSection): DocumentSection {
  if (/application|applicant/i.test(text)) return 'application';
  // A numeric label in an unrelated page cannot establish its own provenance.
  // Unrecognized packet layouts keep unknown sections and require human review.
  if (/gross|income|pay period|employer/i.test(text)) return fallback === 'income' ? 'income' : 'unknown';
  if (/existing.*debt|debt obligations/i.test(text)) return fallback === 'terms' ? 'debts' : 'unknown';
  if (/credit score|bureau|score range/i.test(text)) return fallback === 'bureau' ? 'bureau' : 'unknown';
  if (/cash price|financed amount|monthly payment|term:|fixed apr|vehicle quote/i.test(text)) return fallback === 'terms' ? 'terms' : 'unknown';
  return fallback;
}

/** Parse real Tesseract TSV into line blocks and numeric-token provenance coordinates. */
export function parseTesseractTsv(tsv: string, pageNumber: number): { width: number; height: number; blocks: OcrBlock[] } {
  let width = 0;
  let height = 0;
  const lines = new Map<string, { tokens: OcrBlock['tokens']; box: BoundingBox }>();
  for (const line of tsv.split(/\r?\n/).slice(1)) {
    const columns = line.split('\t');
    if (columns.length < 12) continue;
    const [level, , block, paragraph, row, , left, top, tokenWidth, tokenHeight, confidence] = columns;
    if (level === '1') { width = Number(tokenWidth); height = Number(tokenHeight); continue; }
    const text = columns.slice(11).join('\t').trim();
    if (level !== '5' || !text || Number(tokenWidth) <= 0 || Number(tokenHeight) <= 0) continue;
    const box = { x: Number(left), y: Number(top), width: Number(tokenWidth), height: Number(tokenHeight) };
    const score = Number(confidence);
    const token = { text, confidence: Number.isFinite(score) && score >= 0 && score <= 100 ? score : null, boundingBox: box };
    const id = `p${pageNumber}-b${block}-p${paragraph}-l${row}`;
    const current = lines.get(id);
    if (!current) lines.set(id, { tokens: [token], box });
    else {
      const right = Math.max(current.box.x + current.box.width, box.x + box.width);
      const bottom = Math.max(current.box.y + current.box.height, box.y + box.height);
      current.box.x = Math.min(current.box.x, box.x);
      current.box.y = Math.min(current.box.y, box.y);
      current.box.width = right - current.box.x;
      current.box.height = bottom - current.box.y;
      current.tokens.push(token);
    }
  }
  if (width <= 0 || height <= 0) throw new Error('Tesseract TSV is missing valid page dimensions.');
  const allText = [...lines.values()].flatMap((line) => line.tokens.map((token) => token.text)).join(' ');
  let pageSection: DocumentSection = 'unknown';
  if (/INCOME EVIDENCE|PAY SUMMARY/i.test(allText)) pageSection = 'income';
  else if (/BUREAU SUMMARY/i.test(allText)) pageSection = 'bureau';
  else if (/VEHICLE QUOTE/i.test(allText)) pageSection = 'terms';
  const blocks = [...lines.entries()].map(([id, line]): OcrBlock => {
    const text = line.tokens.map((token) => token.text).join(' ');
    const known = line.tokens.flatMap((token) => token.confidence === null ? [] : [token.confidence]);
    return { id, text, boundingBox: line.box, tokens: line.tokens,
      confidence: known.length ? known.reduce((total, value) => total + value, 0) / known.length : null,
      section: sectionFor(text, pageSection) };
  });
  return { width, height, blocks };
}

export function createOcrActivities(store: OcrStore) {
  async function validatePdf(input: OcrDocumentInput): Promise<PdfValidation> {
    const bytes = await store.getBytes(input.document.key);
    const validation = await validatePdfBytes(bytes);
    if (validation.sha256 !== input.documentHash || validation.sha256 !== input.document.sha256) {
      throw ApplicationFailure.nonRetryable('PDF reference hash does not match immutable bytes.', 'ARTIFACT_INTEGRITY_ERROR');
    }
    return validation;
  }

  async function renderPdf(input: OcrDocumentInput): Promise<RenderResult> {
    if (input.document.sha256 !== input.documentHash) {
      throw ApplicationFailure.nonRetryable('PDF reference hash does not match its document identity.', 'ARTIFACT_INTEGRITY_ERROR');
    }
    const ocrVersion = input.ocrVersion ?? process.env.OCR_VERSION ?? DEFAULT_OCR_VERSION;
    artifactKey(input.documentHash, ocrVersion, 1, 'renders');
    const engine = await runOcrCommand('tesseract', ['--version']);
    const renderer = await runOcrCommand('pdftoppm', ['-v']);
    const engineVersion = `${engine.split(/\r?\n/)[0] ?? 'tesseract'}; ${renderer.split(/\r?\n/)[0] ?? 'poppler'}; ${OCR_DPI} DPI; ${ocrVersion}`;
    const manifestKey = `renders/${input.documentHash}/${ocrVersion}/manifest.json`;
    if (await store.exists(manifestKey)) {
      const cached = await store.getJson<RenderResult>(manifestKey);
      if (cached.engineVersion !== engineVersion) {
        throw ApplicationFailure.nonRetryable('OCR tools changed; use a new OCR_VERSION to preserve immutable artifacts.', 'OCR_CONFIGURATION_ERROR');
      }
      return cached;
    }
    const bytes = await store.getBytes(input.document.key);
    const validation = await validatePdfBytes(bytes);
    if (validation.sha256 !== input.documentHash || validation.sha256 !== input.document.sha256) {
      throw ApplicationFailure.nonRetryable('PDF reference hash does not match immutable bytes.', 'ARTIFACT_INTEGRITY_ERROR');
    }
    const directory = await mkdtemp(join(tmpdir(), 'loan-render-'));
    try {
      const pdfPath = join(directory, 'packet.pdf');
      await writeFile(pdfPath, bytes);
      const pages: RenderedPage[] = [];
      for (let pageNumber = 1; pageNumber <= validation.pages; pageNumber += 1) {
        const key = artifactKey(input.documentHash, ocrVersion, pageNumber, 'renders');
        let png: Buffer;
        if (await store.exists(key)) png = await store.getBytes(key);
        else {
          const prefix = join(directory, `page-${pageNumber}`);
          await runOcrCommand('pdftoppm', ['-f', String(pageNumber), '-l', String(pageNumber), '-singlefile', '-r', String(OCR_DPI), '-png', pdfPath, prefix],
            { documentHash: input.documentHash, pageNumber, stage: 'render', artifactKey: key });
          png = await readFile(`${prefix}.png`);
        }
        const imageRef = await store.putImmutable(key, png, 'image/png');
        pages.push({ pageNumber, ...pngSize(png), imageRef, pageHash: imageRef.sha256 });
        activityContext()?.heartbeat({ documentHash: input.documentHash, pageNumber, artifactKey: key });
      }
      const rendered = { documentHash: input.documentHash, ocrVersion, engineVersion, pages };
      await store.putJsonImmutable(manifestKey, rendered);
      return rendered;
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async function ocrPage(input: OcrPageInput): Promise<OcrPageResult> {
    const key = artifactKey(input.documentHash, input.ocrVersion, input.page.pageNumber, 'ocr');
    if (await store.exists(key)) {
      const cached = ocrPageSchema.parse(await store.getJson<unknown>(key));
      if (cached.pageHash !== input.page.pageHash || cached.engineVersion !== input.engineVersion) {
        throw ApplicationFailure.nonRetryable('Cached OCR page has an incompatible immutable revision.', 'ARTIFACT_INTEGRITY_ERROR');
      }
      return { pageNumber: cached.pageNumber, artifact: await store.putJsonImmutable(key, cached) };
    }
    const directory = await mkdtemp(join(tmpdir(), 'loan-ocr-'));
    try {
      const bytes = await store.getBytes(input.page.imageRef.key);
      if (sha256(bytes) !== input.page.pageHash) throw ApplicationFailure.nonRetryable('Rendered page hash mismatch.', 'ARTIFACT_INTEGRITY_ERROR');
      const path = join(directory, 'page.png');
      await writeFile(path, bytes);
      // An explicit fixture-only recovery demonstration pause; no OCR result is substituted.
      const pause = Math.min(60_000, Math.max(0, Number(process.env.OCR_TEST_DELAY_MS ?? '0')));
      if (process.env.MODE === 'fixture' && input.page.pageNumber === 2 && pause > 0) {
        const context = activityContext();
        const heartbeats = setInterval(() => context?.heartbeat({ artifactKey: key, pageNumber: 2, stage: 'fixture-recovery-pause' }), 5_000);
        try {
          await delay(pause, undefined, { signal: context?.cancellationSignal });
        } catch (error) {
          if (context?.cancellationSignal.aborted) throw new CancelledFailure('OCR activity cancelled.');
          throw error;
        } finally { clearInterval(heartbeats); }
      }
      const tsv = await runOcrCommand('tesseract', [path, 'stdout', '-l', 'eng', '--psm', '6', 'tsv'],
        { documentHash: input.documentHash, pageNumber: input.page.pageNumber, artifactKey: key });
      const parsed = parseTesseractTsv(tsv, input.page.pageNumber);
      const page = ocrPageSchema.parse({ ...input.page, ...parsed, engineVersion: input.engineVersion });
      return { pageNumber: page.pageNumber, artifact: await store.putJsonImmutable(key, page) };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async function saveOcrManifest(input: { documentHash: string; ocrVersion: string; engineVersion: string; pages: OcrPageResult[] }): Promise<OcrResult> {
    const ordered = [...input.pages].sort((a, b) => a.pageNumber - b.pageNumber);
    if (ordered.length === 0 || ordered.length > MAX_PDF_PAGES || ordered.some((page, index) => page.pageNumber !== index + 1)) {
      throw ApplicationFailure.nonRetryable('OCR manifest requires every ordered page exactly once.', 'ARTIFACT_INTEGRITY_ERROR');
    }
    const pages = await Promise.all(ordered.map(async ({ artifact, pageNumber }) => {
      if (artifact.key !== artifactKey(input.documentHash, input.ocrVersion, pageNumber, 'ocr')) {
        throw ApplicationFailure.nonRetryable('OCR page belongs to another immutable document revision.', 'ARTIFACT_INTEGRITY_ERROR');
      }
      const bytes = await store.getBytes(artifact.key);
      if (sha256(bytes) !== artifact.sha256) throw ApplicationFailure.nonRetryable('OCR page artifact hash mismatch.', 'ARTIFACT_INTEGRITY_ERROR');
      const page = ocrPageSchema.parse(JSON.parse(bytes.toString('utf8')));
      if (page.pageNumber !== pageNumber) throw new Error('OCR manifest page order mismatch.');
      return page;
    }));
    const qualityFlags: string[] = [];
    for (const page of pages) {
      if (page.blocks.length === 0) qualityFlags.push(`EMPTY_OCR_PAGE:${page.pageNumber}`);
      const numeric = page.blocks.flatMap((block) => block.tokens).filter((token) => /\d/.test(token.text));
      if (numeric.some((token) => token.confidence === null)) qualityFlags.push(`OCR_CONFIDENCE_MISSING:${page.pageNumber}`);
      if (numeric.some((token) => token.confidence !== null && token.confidence < 90)) qualityFlags.push(`OCR_LOW_CONFIDENCE:${page.pageNumber}`);
    }
    const manifest: OcrManifest = ocrManifestSchema.parse({ ...input, pages, qualityFlags });
    const ref = await store.putJsonImmutable(`ocr/${input.documentHash}/${input.ocrVersion}/manifest.json`, manifest);
    return { manifest: ref, qualityFlags };
  }

  return { validatePdf, renderPdf, ocrPage, saveOcrManifest };
}

export type OcrActivities = ReturnType<typeof createOcrActivities>;
