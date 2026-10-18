import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { renderSchema } from '../scripts/generate.ts';
import { createApiClient, type Problem } from '../src/index.ts';

const schemaUrl = new URL('../src/generated/schema.ts', import.meta.url);

function jsonResponse(body: unknown, status: number, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } });
}

describe('generated schema', () => {
  it('matches contracts/openapi.json', async () => {
    expect(await readFile(schemaUrl, 'utf8')).toBe(await renderSchema());
  });

  it('covers the health routes and the Problem shape', async () => {
    const source = await readFile(schemaUrl, 'utf8');
    expect(source).toContain("'/health/live': {");
    expect(source).toContain("'/health/ready': {");
    expect(source).toMatch(/\bProblem: \{/);
  });
});

describe('createApiClient', () => {
  it('calls typed routes against the base URL', async () => {
    const requests: Request[] = [];
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: (request: Request) => {
        requests.push(request);
        return Promise.resolve(jsonResponse({ status: 'ok' }, 200));
      },
    });

    const { data, error } = await client.GET('/health/live');

    expect(error).toBeUndefined();
    expect(data?.status).toBe('ok');
    expect(requests[0]?.url).toBe('http://api.test/health/live');
  });

  it('surfaces 503 readiness reports as errors', async () => {
    const report = { status: 'unavailable', checks: { redis: { status: 'error' } } };
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: () => Promise.resolve(jsonResponse(report, 503)),
    });

    const { data, error, response } = await client.GET('/health/ready');

    expect(data).toBeUndefined();
    expect(response.status).toBe(503);
    expect(error).toEqual(report);
  });

  it('types problem details as the API sends them (absent optional fields)', async () => {
    const body: Problem = { type: 'about:blank', title: 'Not Found', status: 404 };
    const client = createApiClient({
      baseUrl: 'http://api.test',
      fetch: () => Promise.resolve(jsonResponse(body, 404, 'application/problem+json')),
    });

    const { error, response } = await client.GET('/health/live');

    expect(response.status).toBe(404);
    expect(error).toEqual(body);
  });
});
