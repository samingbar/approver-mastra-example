import { z } from 'zod';

const configSchema = z.object({
  mode: z.enum(['fixture', 'live']),
  brandName: z.string().min(1).max(64),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
  admissionLimit: z.coerce.number().int().min(1).max(1000),
  publicOrigin: z.string().url().optional(),
  fixtureManifestPath: z.string(),
  uiDistPath: z.string(),
  reviewerUsersPath: z.string(),
});

export type ApiConfig = z.infer<typeof configSchema>;

export function readApiConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  return configSchema.parse({
    mode: environment['MODE'] ?? environment['APP_MODE'] ?? 'fixture',
    brandName: environment['COMPANY_NAME'] ?? environment['BRAND_NAME'] ?? 'Rivian-inspired demo',
    accentColor: environment['ACCENT_COLOR'] ?? '#b36528',
    host: environment['HOST'] ?? environment['API_HOST'] ?? '127.0.0.1',
    port: environment['PORT'] ?? environment['API_PORT'] ?? '3000',
    admissionLimit: environment['MAX_ACTIVE_APPLICATIONS'] ?? environment['APPLICATION_ADMISSION_LIMIT'] ?? '200',
    publicOrigin: environment['PUBLIC_ORIGIN'],
    fixtureManifestPath: environment['FIXTURE_MANIFEST_PATH'] ?? 'fixtures/manifest.json',
    uiDistPath: environment['UI_DIST_PATH'] ?? 'ui/dist',
    reviewerUsersPath: environment['REVIEWER_USERS_FILE'] ?? '.local/reviewers.json',
  });
}
