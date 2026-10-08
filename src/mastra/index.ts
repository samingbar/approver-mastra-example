import { Mastra } from '@mastra/core/mastra';
import { extractApplicationWorkflow } from './extraction.js';

export const mastra = new Mastra({
  // Provider SDK exceptions can contain private request/response bodies.
  // Metadata-only diagnostics provide the persisted observability surface.
  logger: false,
  loggerOptions: { export: false, correlation: false },
  workflows: { extractApplicationWorkflow },
});
