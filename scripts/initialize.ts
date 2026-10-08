import 'dotenv/config';
import { bootstrapDatabase } from '../src/db/bootstrap.js';
import { ArtifactStore } from '../src/storage.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) throw new Error('DATABASE_ADMIN_URL required for local initialization.');
const artifacts = new ArtifactStore();
try {
  // Services can accept TCP before storage becomes ready. Bounded startup retry.
  for (let attempt = 1; ; attempt++) {
    try { await bootstrapDatabase(adminUrl); await artifacts.ensureBucket(); break; }
    catch (error) {
      if (attempt >= 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  console.log('Local database schema and artifact bucket initialized.');
} finally { artifacts.close(); }
