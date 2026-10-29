// @vitest-environment jsdom
// DOC-03 `텍스트 내보내기`: the relay paths and file names, the failure messages, `전체 복사` through
// the clipboard (one write of the Markdown) and the menu's groups for an editor with a draft.
import './dom-setup';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyRevisionOf } from '../src/components/documents/editor/document-editor';
import { TextExportMenu } from '../src/components/documents/text-export-menu';
import {
  attachmentName,
  copyText,
  fallbackName,
  fetchDocumentText,
  textExportPath,
  TextExportError,
} from '../src/lib/documents/text-export';

const DOC = '11111111-2222-4333-8444-555555555555';
const MD = '# 제목\n\n본문\n';

function fileResponse(body: string, name: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="x.md"; filename*=UTF-8''${encodeURIComponent(name)}`,
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('text export helpers', () => {
  it('builds relay paths for both formats and the draft', () => {
    expect(textExportPath(DOC, 'md')).toBe(`/api/documents/${DOC}/text?format=md`);
    expect(textExportPath(DOC, 'txt', 'draft')).toBe(
      `/api/documents/${DOC}/text?format=txt&revision=draft`,
    );
    expect(textExportPath(DOC, 'md', DOC)).toBe(
      `/api/documents/${DOC}/text?format=md&revision=${DOC}`,
    );
  });

  it('reads the RFC 5987 file name, else the plain one', () => {
    expect(attachmentName(`attachment; filename="a.md"; filename*=UTF-8''%EB%AC%BC.md`)).toBe(
      '물.md',
    );
    expect(attachmentName('attachment; filename="a.md"')).toBe('a.md');
    expect(attachmentName('inline; filename="a.md"')).toBeNull();
    expect(attachmentName(null)).toBeNull();
  });

  it('falls back to a clean `<title>.<ext>` name', () => {
    expect(fallbackName('a/b\\c\u0000', 'md', 'published')).toBe('abc.md');
    expect(fallbackName('책', 'txt', 'draft')).toBe('책 (초안).txt');
    expect(fallbackName('  ', 'md', 'published')).toBe('document.md');
  });

  it('maps 409 document-not-ready and other failures to their messages', async () => {
    const notReady = vi.fn(async () =>
      Response.json(
        { type: 'urn:quiz-workspace:problem:document-not-ready', status: 409 },
        { status: 409 },
      ),
    );
    await expect(fetchDocumentText(DOC, 't', 'md', 'published', notReady)).rejects.toMatchObject({
      reason: 'notReady',
      message: '아직 처리 중인 문서입니다.',
    });
    const forbidden = vi.fn(async () => Response.json({}, { status: 403 }));
    await expect(fetchDocumentText(DOC, 't', 'md', 'draft', forbidden)).rejects.toBeInstanceOf(
      TextExportError,
    );
    const offline = vi.fn(async () => {
      throw new TypeError('offline');
    });
    await expect(fetchDocumentText(DOC, 't', 'md', 'published', offline)).rejects.toMatchObject({
      message: '텍스트를 내보내지 못했습니다. 다시 시도하세요.',
    });
  });

  it('returns the server file name and the exact bytes', async () => {
    const ok = vi.fn(async () => fileResponse(MD, '책 (초안).md'));
    const file = await fetchDocumentText(DOC, '책', 'md', 'draft', ok);
    expect(file.name).toBe('책 (초안).md');
    expect(await file.blob.text()).toBe(MD);
    expect(ok).toHaveBeenCalledWith(
      `/api/documents/${DOC}/text?format=md&revision=draft`,
      expect.objectContaining({ cache: 'no-store', credentials: 'same-origin' }),
    );
  });

  it('copies once through writeText when ClipboardItem is unavailable', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('ClipboardItem', undefined);
    const load = vi.fn(async () => MD);
    await copyText(load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(MD);
  });
});

describe('copyRevisionOf (DOC-02 전체 복사)', () => {
  const info = (id: string, status: 'draft' | 'published', isActive: boolean) =>
    ({ id, status, is_active: isActive }) as Parameters<typeof copyRevisionOf>[0];
  it('copies the draft, the published revision, or an older pinned revision by id', () => {
    expect(copyRevisionOf(null)).toBe('published');
    expect(copyRevisionOf(info('r2', 'draft', false))).toBe('draft');
    expect(copyRevisionOf(info('r1', 'published', true))).toBe('published');
    expect(copyRevisionOf(info('r0', 'published', false))).toBe('r0');
  });
});

describe('TextExportMenu', () => {
  it('names the row button after the document and lists both formats', async () => {
    const user = userEvent.setup();
    render(<TextExportMenu documentId={DOC} title="물의 순환" variant="row" />);
    const button = screen.getByRole('button', { name: '물의 순환 텍스트 내보내기' });
    await user.click(button);
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((i) => i.textContent),
    ).toEqual(['Markdown (.md)', '텍스트 (.txt)']);
    expect(within(menu).queryByRole('group')).toBeNull();
  });

  it('groups 발행본 / 교정 중 초안 for a draft and copies the visible revision', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => fileResponse(MD, '책 (초안).md'));
    vi.stubGlobal('fetch', fetchMock);
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(
      <TextExportMenu documentId={DOC} title="책" variant="header" draft copyRevision="draft" />,
    );
    await user.click(screen.getByRole('button', { name: '텍스트 내보내기' }));
    const menu = await screen.findByRole('menu');
    const published = within(menu).getByRole('group', { name: '발행본' });
    const draft = within(menu).getByRole('group', { name: '교정 중 초안' });
    expect(within(published).getAllByRole('menuitem')).toHaveLength(2);
    expect(within(draft).getAllByRole('menuitem')).toHaveLength(2);
    await user.click(within(menu).getByRole('menuitem', { name: '전체 복사' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('복사했습니다'));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(MD);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/documents/${DOC}/text?format=md&revision=draft`,
      expect.anything(),
    );
  });

  it('shows the not-ready reason as an alert', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { type: 'urn:quiz-workspace:problem:document-not-ready', status: 409 },
          { status: 409 },
        ),
      ),
    );
    render(<TextExportMenu documentId={DOC} title="책" variant="row" />);
    await user.click(screen.getByRole('button', { name: '책 텍스트 내보내기' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Markdown (.md)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('아직 처리 중인 문서입니다.');
    // The menu stays closed once the export is over (it never reopens by itself).
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
