import assert from 'node:assert/strict';
import { loadFixtureManifest } from '../src/fixtures/index.js';
import { DemoClient } from './demo-client.js';

const client = new DemoClient();
const manifest = await loadFixtureManifest();
await client.login();
const requested = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const ids = requested.length ? requested : ['pass', 'fail', 'borderline'];
const uploaded = [];
for (const id of ids) {
  const fixture = manifest.fixtures.find((entry) => entry.id === id);
  if (!fixture) throw new Error(`Unknown fixture ${id}; choose ${manifest.fixtures.map((entry) => entry.id).join(', ')}`);
  const { applicationId } = await client.upload(fixture);
  console.log(`Uploaded ${fixture.id}: ${client.origin}/#applications/${applicationId}`);
  uploaded.push({ fixture, applicationId });
}
for (const { fixture, applicationId } of uploaded) {
  const app = await client.waitForApplication(applicationId);
  assert.equal(app.status, fixture.expectedDecision, `${fixture.id} must match its declared educational expectation`);
  if (app.status !== 'REVIEW') {
    const audit = await client.audit(applicationId);
    assert.equal(audit.events.filter((event) => event.type === 'FINAL_COMMITTED').length, 1);
    assert.equal(audit.application.auditCommitted, true);
  }
  console.log(`${fixture.id}: ${app.status} · Educational simulation · ${applicationId}`);
}
console.log('Fixture walkthrough ready. Open the review queue for the borderline case.');
