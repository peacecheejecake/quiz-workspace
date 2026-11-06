// UX12-CHAPTERSCROLL (docs/screens/ux12-doc-count-chapter-scroll.md): 문서 N counts what 문서 관리
// lists, whatever the PDF's kind.

import { uploadPdf, uploadReadyBook, waitForJob } from '../fixtures/documents.ts';
import { questionPaper } from '../fixtures/questions.ts';
import { docUi, expect, homePath, homeUi, signInAs, test } from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

test(
  'UX12-CHAPTERSCROLL-AC01 문서 N counts every PDF of 문서 관리, a question paper too',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-doc-count');
    const ws = await workspaceFactory.create(owner);
    await uploadReadyBook(owner, ws.id, 'book-ko');
    const uploaded = await uploadPdf(owner, ws.id, questionPaper(), 'question_paper');
    await waitForJob(owner, uploaded.jobId);

    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    const count = homeUi.documentsButton(page);
    await expect(count).toHaveText(/문서\s*2$/);

    await homeUi.openDocuments(page);
    const dialog = homeUi.documentsDialog(page);
    await expect(docUi.item(page, /book-ko/)).toBeVisible();
    await expect(docUi.item(page, /questions-ko/)).toBeVisible();
    await expect(
      dialog.getByRole('list', { name: /문서 목록|documents/i }).getByRole('listitem'),
    ).toHaveCount(2);

    const paperRow = docUi.item(page, /questions-ko/);
    await paperRow.getByRole('button', { name: /삭제|delete/i }).click();
    const confirm = page.getByRole('alertdialog', { name: /삭제|delete/i });
    await confirm.getByRole('button', { name: /^(삭제|delete)$/i }).click();
    await expect(docUi.item(page, /questions-ko/)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(count).toHaveText(/문서\s*1$/);
  },
);
