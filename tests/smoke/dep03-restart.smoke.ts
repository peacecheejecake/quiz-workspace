// DEP-03 (docs/deployment.md §9): job state, practice attempts and document revisions survive an
// API/Worker restart. Two runs around the restart, selected by SMOKE_DEP03_PHASE:
//
//   seed    account A: workspace + synthetic fixture PDF through the real upload path (upload-intent
//           → signed Storage PUT → complete-upload) until the parse job succeeds, an MCQ answered
//           once; ids written to <SMOKE_STATE_DIR>/dep03.json (ids and statuses only)
//   (restart the API and worker: Railway "Restart" on both services, or a redeploy; locally a
//    second `make smoke-local`, which starts fresh server processes)
//   verify  the same ids answer with the same job status/finish time, the same active revision and
//           revision list, the same question revision and the recorded attempt; then the
//           workspace is deleted (SMOKE_KEEP=1 keeps it)
//
// Without SMOKE_DEP03_PHASE this file declares no test.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { Api, createMcq, createWorkspace, deleteWorkspace, raw } from './client.ts';
import { REPO_ROOT, smokeEnv } from './env.ts';

const phase = process.env.SMOKE_DEP03_PHASE?.trim();
const env = smokeEnv();
const STATE = join(env.stateDir, 'dep03.json');
const FIXTURE = join(REPO_ROOT, 'tests/fixtures/pdfs/book-en.pdf');

interface Job {
  readonly id: string;
  readonly status: string;
  readonly finished_at: string | null;
}

interface State {
  readonly workspaceId: string;
  readonly documentId: string;
  readonly jobId: string;
  readonly jobFinishedAt: string | null;
  readonly activeRevisionId: string;
  readonly revisionIds: readonly string[];
  readonly questionId: string;
  readonly questionRevisionId: string;
  readonly attemptId: string;
}

async function revisionIds(api: Api, documentId: string): Promise<string[]> {
  const body = await api.ok<{ items: { id: string }[] }>(
    'GET',
    `/documents/${documentId}/revisions`,
    undefined,
    [200],
  );
  return body.items.map((r) => r.id);
}

if (phase === 'seed') {
  test('DEP-03 seed: a parsed document, a job and an attempt before the restart', async () => {
    test.setTimeout(env.jobTimeoutMs + 120_000);
    const owner = await Api.as('a');
    const ws = await createWorkspace(owner, 'dep03');

    const bytes = readFileSync(FIXTURE);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const intent = await owner.ok<{
      upload_id: string;
      upload_url: string;
      upload_headers?: Record<string, string>;
    }>(
      'POST',
      `/workspaces/${ws.id}/documents/upload-intent`,
      {
        filename: 'smoke-book-en.pdf',
        size_bytes: bytes.length,
        content_type: 'application/pdf',
        sha256,
      },
      [200, 201],
    );
    // Signed Storage URL: used once, never logged or stored.
    const put = await raw(intent.upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf', ...intent.upload_headers },
      body: bytes,
    });
    expect(put.status, 'direct Storage upload').toBeLessThan(300);
    const done = await owner.ok<{ document_id: string; job_id: string }>(
      'POST',
      '/documents/complete-upload',
      { upload_id: intent.upload_id, sha256 },
      [202],
    );

    let job: Job | undefined;
    await expect
      .poll(
        async () =>
          (job = await owner.ok<Job>('GET', `/jobs/${done.job_id}`, undefined, [200])).status,
        {
          message: 'document.parse job reaches a terminal status',
          timeout: env.jobTimeoutMs,
          intervals: [2_000, 5_000, 10_000],
        },
      )
      .toMatch(/^(succeeded|failed|cancelled)$/);
    expect(job?.status).toBe('succeeded');

    const document = await owner.ok<{ active_revision_id: string | null }>(
      'GET',
      `/documents/${done.document_id}`,
      undefined,
      [200],
    );
    const activeRevisionId = document.active_revision_id;
    if (!activeRevisionId) throw new Error('parsed document has no active revision');

    const question = await createMcq(owner, ws.id);
    const session = await owner.ok<{ id: string }>(
      'POST',
      `/questions/${question.id}/practice-sessions`,
      {},
      [201],
    );
    const submitted = await owner.ok<{ attempt_id: string }>(
      'POST',
      `/practice-sessions/${session.id}/submit`,
      { selected_option_ids: ['opt-1'] },
      [200],
    );

    const state: State = {
      workspaceId: ws.id,
      documentId: done.document_id,
      jobId: done.job_id,
      jobFinishedAt: job?.finished_at ?? null,
      activeRevisionId,
      revisionIds: await revisionIds(owner, done.document_id),
      questionId: question.id,
      questionRevisionId: question.revision.id,
      attemptId: submitted.attempt_id,
    };
    mkdirSync(env.stateDir, { recursive: true });
    writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  });
}

if (phase === 'verify') {
  test('DEP-03 verify: the same state answers after the restart', async () => {
    const state = JSON.parse(readFileSync(STATE, 'utf8')) as State;
    const owner = await Api.as('a');
    try {
      const job = await owner.ok<Job>('GET', `/jobs/${state.jobId}`, undefined, [200]);
      expect(job.status).toBe('succeeded');
      expect(job.finished_at).toBe(state.jobFinishedAt);

      const document = await owner.ok<{ active_revision_id: string; status: string }>(
        'GET',
        `/documents/${state.documentId}`,
        undefined,
        [200],
      );
      expect(document.active_revision_id).toBe(state.activeRevisionId);
      expect(await revisionIds(owner, state.documentId)).toEqual(state.revisionIds);

      const question = await owner.ok<{ revision: { id: string } }>(
        'GET',
        `/questions/${state.questionId}`,
        undefined,
        [200],
      );
      expect(question.revision.id).toBe(state.questionRevisionId);
      const attempts = await owner.ok<{ items: { id: string }[] }>(
        'GET',
        `/questions/${state.questionId}/attempts`,
        undefined,
        [200],
      );
      expect(attempts.items.map((a) => a.id)).toContain(state.attemptId);
      rmSync(STATE);
    } finally {
      if (process.env.SMOKE_KEEP !== '1') await deleteWorkspace(owner, state.workspaceId);
    }
  });
}
