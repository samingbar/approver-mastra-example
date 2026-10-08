import 'dotenv/config';
import { setTimeout as delay } from 'node:timers/promises';
import { readFixtureBytes, type Fixture } from '../src/fixtures/index.js';
import type { ApplicationAudit, ApplicationProjection } from '../src/storage.js';

export const finalStatuses = new Set(['PASS', 'FAIL', 'NEEDS_DOCUMENTS', 'INPUT_ERROR', 'PROCESSING_ERROR', 'CANCELLED']);

/** Local fixture walkthrough client. No cloud provisioning or external account calls. */
export class DemoClient {
  private cookie = '';
  readonly origin: string;
  constructor(origin = process.env.DEMO_API_ORIGIN ?? `http://localhost:${process.env.LOCAL_APP_PORT ?? '3000'}`) {
    const url = new URL(origin);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error('Demo commands require a local API origin');
    }
    this.origin = url.origin;
  }

  async login(): Promise<void> {
    const response = await fetch(`${this.origin}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewerId: 'demo-reviewer' }), signal: AbortSignal.timeout(15_000),
    });
    await readResponse(response);
    const cookie = response.headers.get('set-cookie');
    if (!cookie) throw new Error('Fixture reviewer session was not issued');
    this.cookie = cookie.split(';')[0]!;
  }

  async upload(fixture: Fixture): Promise<{ applicationId: string; workflowId: string }> {
    const bytes = await readFixtureBytes(fixture.id);
    const form = new FormData();
    form.set('document', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), fixture.filename);
    return await this.request('/api/applications', { method: 'POST', body: form });
  }

  async application(id: string): Promise<ApplicationProjection> {
    const result = await this.request<ApplicationProjection | { application: ApplicationProjection }>(`/api/applications/${id}`);
    return 'application' in result ? result.application : result;
  }

  async audit(id: string): Promise<ApplicationAudit> {
    return await this.request(`/api/applications/${id}/audit`);
  }

  async waitForApplication(id: string, timeoutMs = 1_200_000): Promise<ApplicationProjection> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const app = await this.application(id);
      if (app.status === 'REVIEW' || (finalStatuses.has(app.status) && app.auditCommitted)) return app;
      await delay(500);
    }
    throw new Error(`Application ${id} did not reach review or an audited outcome before the local timeout`);
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    return await readResponse(await this.response(path, options)) as T;
  }

  async response(path: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set('cookie', this.cookie);
    return await fetch(`${this.origin}${path}`, {
      ...options, headers, signal: options.signal ?? AbortSignal.timeout(30_000),
    });
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'code' in body ? String(body.code) : 'HTTP_ERROR';
    throw new Error(`Local API returned ${response.status} ${code}`);
  }
  return body;
}
