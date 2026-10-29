// @vitest-environment jsdom
// DOC-01-AC05 (UX3-JOB): a processing row shows the server's job status and stage even when this
// tab does not follow the job live (after a reload), "처리 준비 중" while a cold worker loads the
// parser's models, and the elapsed time with a hint once the job has taken longer than 30 s.
import './dom-setup';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentRowItem } from '../src/components/documents/document-row';
import {
  documentProgress,
  formatElapsed,
  processingElapsed,
  processingLabel,
  SLOW_PROCESSING_HINT,
} from '../src/components/documents/labels';
import type { DocumentSummary } from '../src/lib/documents/client-api';
import { buildRows, type DocumentRow, type UploadItem } from '../src/lib/documents/upload-machine';

const QUEUED_AT = '2026-10-19T18:10:00Z';
const STARTED_AT = '2026-10-19T18:10:01Z';
const T_QUEUED = Date.parse(QUEUED_AT);
const T_STARTED = Date.parse(STARTED_AT);

type ProcessingJob = NonNullable<DocumentSummary['processing_job']>;

function doc(job: Partial<ProcessingJob> | null, extra: Partial<DocumentSummary> = {}) {
  return {
    id: 'd1',
    workspace_id: 'ws',
    document_type: 'book',
    title: '합성 교재',
    filename: 'book.pdf',
    size_bytes: 100,
    sha256: 'a'.repeat(64),
    status: 'processing',
    active_revision_id: null,
    last_error: null,
    created_at: QUEUED_AT,
    updated_at: QUEUED_AT,
    processing_job: job
      ? {
          id: 'j1',
          status: 'running',
          stage: null,
          progress: null,
          created_at: QUEUED_AT,
          started_at: STARTED_AT,
          ...job,
        }
      : null,
    ...extra,
  } satisfies DocumentSummary;
}

function row(job: Partial<ProcessingJob> | null, extra: Partial<DocumentSummary> = {}) {
  const [only] = buildRows([doc(job, extra)], []);
  return only as DocumentRow;
}

describe('DOC-01-AC05 processing rows from the documents list', () => {
  it('DOC-01-AC05 a listed processing document carries its job, so a reload keeps the stage', () => {
    expect(row(null).job).toBeUndefined();
    expect(processingLabel(row(null))).toBe('처리 대기 중');
    expect(processingLabel(row({ status: 'queued', started_at: null }))).toBe('처리 대기 중');
    expect(processingLabel(row({ stage: 'preparing', progress: 2 }))).toBe('처리 준비 중');
    expect(processingLabel(row({ stage: 'parsing', progress: 15 }))).toBe('처리 중 · 파싱 중');
    expect(processingLabel(row({ stage: null }))).toBe('처리 중');
    expect(row({ stage: 'indexing', progress: 60 }).job).toMatchObject({
      status: 'running',
      stage: 'indexing',
      progress: 60,
      queuedAt: QUEUED_AT,
      startedAt: STARTED_AT,
    });
    // A ready document never shows a stale job.
    expect(row({ stage: 'publishing' }, { status: 'ready' }).job).toBeUndefined();
  });

  it('DOC-01-AC05 an upload followed live falls back to the listed job until its first event', () => {
    const upload: UploadItem = {
      localId: 'l1',
      filename: 'book.pdf',
      title: '합성 교재',
      size: 100,
      documentType: 'book',
      phase: 'queued',
      loaded: 100,
      stored: true,
      documentId: 'd1',
      jobId: 'j1',
    };
    const [followed] = buildRows([doc({ stage: 'preparing' })], [upload]);
    expect(followed && processingLabel(followed)).toBe('처리 준비 중');
  });

  it('DOC-01-AC05 shows the elapsed time only after 30 seconds, from start or queue time', () => {
    const running = row({ stage: 'parsing' });
    expect(processingElapsed(running, T_STARTED + 30_000)).toBeNull();
    expect(processingElapsed(running, T_STARTED + 31_000)).toBe('31초째 처리 중');
    expect(processingElapsed(running, T_STARTED + 490_000)).toBe('8분 10초째 처리 중');

    const queued = row({ status: 'queued', started_at: null });
    expect(processingElapsed(queued, T_QUEUED + 125_000)).toBe('2분 5초째 대기 중');
    // A client clock behind the server never shows a negative or bogus time.
    expect(processingElapsed(queued, T_QUEUED - 60_000)).toBeNull();
    expect(processingElapsed(row(null), T_QUEUED + 600_000)).toBeNull();
    expect(processingElapsed(row({}, { status: 'ready' }), T_QUEUED + 600_000)).toBeNull();
  });

  it('DOC-01-AC05 formats elapsed time in Korean', () => {
    expect(formatElapsed(0)).toBe('0초');
    expect(formatElapsed(45_400)).toBe('45초');
    expect(formatElapsed(120_000)).toBe('2분');
    expect(formatElapsed(3_720_000)).toBe('1시간 2분');
    expect(formatElapsed(7_200_000)).toBe('2시간');
  });
});

describe('DOC-01-AC05 processing row', () => {
  afterEach(() => vi.useRealTimers());

  it('DOC-01-AC05 renders the stage as text and adds the elapsed time and hint after 30 s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T_STARTED + 5_000);
    render(
      <ul>
        <DocumentRowItem
          row={row({ stage: 'preparing', progress: 2 })}
          workspaceId="ws"
          canEdit={false}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
          onDelete={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getByText('처리 준비 중')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: '파싱·색인 진행률' })).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.queryByText(SLOW_PROCESSING_HINT, { exact: false })).toBeNull();

    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText(/1분 6초째 처리 중 · 첫 처리나 큰 PDF는 몇 분/)).toBeTruthy();
  });
});

// UX6-PROGRESS: one step UI 업로드 → 분석 → 색인 instead of a bar that fills per stage and drops.
describe('DOC-01 step progress (UX6-PROGRESS)', () => {
  function renderRow(r: DocumentRow) {
    return render(
      <ul>
        <DocumentRowItem
          row={r}
          workspaceId="ws"
          canEdit={false}
          onCancel={vi.fn()}
          onRetry={vi.fn()}
          onDelete={vi.fn()}
        />
      </ul>,
    );
  }

  function states(): string[] {
    const list = screen.getByRole('list', { name: '진행 단계' });
    return within(list)
      .getAllByRole('listitem')
      .map((item) => `${item.getAttribute('data-state')}:${item.textContent}`);
  }

  it('DOC-01-AC05 a processing row shows 업로드 done, 분석 current and 색인 pending', () => {
    renderRow(row({ stage: 'preparing', progress: 2 }));
    expect(states()).toEqual(['done:업로드완료', 'current:2분석진행 중', 'pending:3색인대기']);
    const bar = screen.getByRole('progressbar', { name: '파싱·색인 진행률' });
    expect(bar).toHaveAttribute('aria-valuetext', '2/3단계: 처리 준비 중, 4%');
  });

  it('DOC-01-AC02 maps the job stages onto 분석 (0–50 %) and 색인 (50–100 %)', () => {
    const queued = documentProgress(row({ status: 'queued', started_at: null }));
    expect(queued).toMatchObject({ current: 1, text: '처리 대기 중' });
    expect(queued?.value).toBeUndefined();
    expect(documentProgress(row({ stage: 'parsing', progress: 15 }))).toMatchObject({
      current: 1,
      value: 30,
    });
    expect(documentProgress(row({ stage: 'chunking', progress: 50 }))).toMatchObject({
      current: 2,
      value: 0,
    });
    expect(documentProgress(row({ stage: 'publishing', progress: 90 }))).toMatchObject({
      current: 2,
      value: 80,
      text: '게시 중',
    });
    // An unknown stage falls back to the job percent.
    expect(documentProgress(row({ stage: 'mystery', progress: 70 }))).toMatchObject({
      current: 2,
      value: 40,
    });
  });

  it('DOC-01-AC02 an uploading row shows 업로드 current with the sent bytes', () => {
    const uploads: UploadItem[] = [
      {
        localId: 'l1',
        filename: 'book.pdf',
        title: '합성 교재',
        size: 200,
        documentType: 'book',
        phase: 'uploading',
        loaded: 50,
        stored: false,
      },
    ];
    const [uploading] = buildRows([], uploads);
    renderRow(uploading as DocumentRow);
    expect(states()).toEqual(['current:1업로드진행 중', 'pending:2분석대기', 'pending:3색인대기']);
    const bar = screen.getByRole('progressbar', { name: '업로드 진행률' });
    expect(bar).toHaveAttribute('aria-valuetext', '1/3단계: 업로드 중, 25%');
  });
});
