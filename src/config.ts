import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
  MODE: z.enum(['fixture', 'live']).default('fixture'),
  COMPANY_NAME: z.string().min(1).max(80).default('Rivian-inspired Loan Lab'),
  ACCENT_COLOR: z.string().regex(/^#[a-fA-F0-9]{6}$/).default('#b45309'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  TEMPORAL_ADDRESS: z.string().default('127.0.0.1:7233'),
  TEMPORAL_NAMESPACE: z.string().default('default'),
  OCR_ACTIVITY_SLOTS: z.coerce.number().int().min(1).max(16).default(4),
  EXTRACTION_ACTIVITY_SLOTS: z.coerce.number().int().min(1).max(32).default(4),
  APPLICATION_ACTIVITY_SLOTS: z.coerce.number().int().min(1).max(64).default(16),
  MAX_ACTIVE_APPLICATIONS: z.coerce.number().int().min(1).max(1000).default(200),
  MODEL_ID: z.string().default('openai/gpt-4.1-mini'),
  MODEL_API_KEY: z.string().optional(),
});

export function readConfig() { return configSchema.parse(process.env); }
export const config = readConfig();
