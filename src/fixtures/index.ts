import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { loanFactsSchema, reasonCodeSchema, verificationRecordSchema } from '../contracts.js';

const sourceCoordinateSchema = z.object({
  page: z.number().int().positive(), bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]), quotation: z.string(),
});
export const fixtureSchema = z.object({
  id: z.string(), filename: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedDecision: z.enum(['PASS', 'FAIL', 'REVIEW']), expectedReasonCodes: z.array(reasonCodeSchema),
  facts: loanFactsSchema, verification: verificationRecordSchema,
  sourceCoordinates: z.record(z.string(), z.array(sourceCoordinateSchema)),
});
export const fixtureManifestSchema = z.object({
  version: z.string(), renderDpi: z.number(), pageSizePixels: z.tuple([z.number(), z.number()]),
  description: z.string(), fixtures: z.array(fixtureSchema),
});
export type Fixture = z.infer<typeof fixtureSchema>;
export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;

let manifestPromise: Promise<FixtureManifest> | undefined;
export async function loadFixtureManifest(): Promise<FixtureManifest> {
  manifestPromise ??= readFile(new URL('../../fixtures/manifest.json', import.meta.url), 'utf8')
    .then((text) => fixtureManifestSchema.parse(JSON.parse(text)));
  return await manifestPromise;
}

/** Only byte-identical committed packets receive the explicit fictional verification record. */
export async function findFixtureByDocumentHash(documentHash: string): Promise<Fixture | undefined> {
  return (await loadFixtureManifest()).fixtures.find((fixture) => fixture.sha256 === documentHash);
}

export async function readFixtureBytes(id: string): Promise<Buffer> {
  const fixture = (await loadFixtureManifest()).fixtures.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error(`Unknown educational fixture: ${id}`);
  return await readFile(new URL(`../../fixtures/${fixture.filename}`, import.meta.url));
}
