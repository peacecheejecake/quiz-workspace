// UX12 DESIGN-5 — real blur, more see-through glass and the buttons on it (user feedback
// 2026-11-06): docs/screens/ux12-glass-buttons.md. Reads computed styles: pixel output is the
// visual suite's job. This suite runs against the production build, where the blur was lost.
import type { Locator, Page } from '@playwright/test';
import { openAskPanel, openComposer } from '../fixtures/ask.ts';
import {
  chooseWorkspaceAction,
  createQuestion,
  DELETE_ACTION,
  expect,
  homePath,
  mcqInput,
  overviewPath,
  overviewUi,
  panelUi,
  signInAs,
  test,
  uniqueWorkspaceName,
  wsUi,
  type E2EFixtures,
} from '../fixtures/test.ts';

test.use({ storageState: { cookies: [], origins: [] } });

const TRANSPARENT = 'rgba(0, 0, 0, 0)';
const BLUR = /blur\(24px\)/;
const OPAQUE = /^rgb\(/;
const GLASS_ALPHA = { light: 0.7, dark: 0.65 } as const;
const RETURN_LABEL = '보던 문제로 돌아가기';
const EXPLANATION = 'UX12 glass 해설: 첫 번째 보기가 맞습니다.';

function surfaceOf(locator: Locator) {
  return locator.evaluate((element) => {
    const css = getComputedStyle(element);
    return {
      color: css.backgroundColor,
      image: css.backgroundImage,
      blur: css.backdropFilter || css.getPropertyValue('-webkit-backdrop-filter'),
      border: css.borderTopColor,
      borderWidth: css.borderTopWidth,
      position: css.position,
    };
  });
}

/** The token's value resolved by the browser, comparable to a computed background. */
function tokenColor(page: Page, token: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.background = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, token);
}

async function openOverview(
  page: Page,
  workspaceFactory: E2EFixtures['workspaceFactory'],
  name: string,
) {
  const owner = await workspaceFactory.member(name);
  const ws = await workspaceFactory.create(owner);
  await createQuestion(owner, ws.id, {
    question_number: 1,
    explanation: EXPLANATION,
    ...mcqInput('UX12 glass 문제: 알맞은 것을 고르시오.', ['가', '나', '다', '라'], 0),
  });
  await signInAs(page, owner.user);
  await page.goto(overviewPath(ws.id));
  return { owner, ws };
}

async function openPanel(page: Page) {
  await overviewUi.dot(page, 1).click();
  const panel = panelUi.numbered(page, 1);
  await expect(panel).toBeVisible();
  return panel;
}

test(
  'UX12-GLASSBTN-AC01 the top bar, menus and side panels really blur and show the backdrop',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-gb-01');
    const name = uniqueWorkspaceName('UX12 glass2');
    const ws = await workspaceFactory.create(owner, name);
    await createQuestion(owner, ws.id, {
      question_number: 1,
      ...mcqInput('UX12 glass 문제: 알맞은 것을 고르시오.', ['가', '나', '다', '라'], 1),
    });
    await signInAs(page, owner.user);
    await page.goto('/workspaces');
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const translucent = new RegExp(`, ${String(GLASS_ALPHA[colorScheme])}\\)$`);
      const bar = await surfaceOf(page.getByRole('banner'));
      expect(bar.blur, `top bar in ${colorScheme}`).toMatch(BLUR);
      expect(bar.color).toMatch(translucent);
      expect(bar.image).toBe('none');

      await wsUi.moreButton(wsUi.item(wsUi.tabPanel(page), name)).click();
      const menu = await surfaceOf(page.getByRole('menu'));
      expect(menu.blur, `menu in ${colorScheme}`).toMatch(BLUR);
      expect(menu.image).toMatch(/^linear-gradient/);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toBeHidden();
    }

    await page.goto(overviewPath(ws.id));
    await page.emulateMedia({ colorScheme: 'light' });
    const panel = await surfaceOf(await openPanel(page));
    expect(panel.blur).toMatch(BLUR);
    expect(panel.color).toMatch(/, 0\.7\)$/);
  },
);

test.describe('phone sheet', () => {
  test.use({ viewport: { width: 390, height: 664 } });

  test(
    'UX12-GLASSBTN-AC02 a phone sheet stays opaque without blur',
    { tag: '@infra' },
    async ({ page, workspaceFactory }) => {
      await openOverview(page, workspaceFactory, 'ux12-gb-02');
      const sheet = await surfaceOf(await openPanel(page));
      expect(sheet.color).toMatch(OPAQUE);
      expect(sheet.blur).toBe('none');
    },
  );
});

test(
  'UX12-GLASSBTN-AC03 secondary buttons on glass keep a raised fill; the return button and the footer have none',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { ws } = await openOverview(page, workspaceFactory, 'ux12-gb-03');
    const panel = await openPanel(page);
    await panelUi.option(panel, '가').check();
    await panelUi.submit(panel).click();
    await expect(panelUi.result(panel)).toBeVisible();
    const again = panel.getByRole('button', { name: /^다시 풀기$|^solve again$/i });
    await expect(again).toHaveAttribute('data-variant', 'secondary');
    // The press left the pointer on the footer: a resting color needs it away, past the transition.
    await page.mouse.move(0, 0);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const raised = await tokenColor(page, '--color-surface-raised');
      await expect
        .poll(() => again.evaluate((element) => getComputedStyle(element).backgroundColor))
        .toBe(raised);
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await panelUi.close(panel).click();

    const back = page.getByRole('button', { name: RETURN_LABEL });
    await expect(back).toBeVisible();
    await expect
      .poll(() => back.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(TRANSPARENT);
    expect((await surfaceOf(back)).border).not.toBe(TRANSPARENT);

    const hover = await tokenColor(page, '--color-state-hover');
    await back.hover();
    await expect
      .poll(() => back.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(hover);

    await page.goto(`/workspaces/${ws.id}?panel=share`);
    const footer = page.locator('.qz-panel > .footer');
    await expect(footer).toBeVisible();
    expect((await surfaceOf(footer)).color).toBe(TRANSPARENT);
  },
);

test(
  'UX12-GLASSBTN-AC04 the explanation area on glass stays the grey muted surface in both themes',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openOverview(page, workspaceFactory, 'ux12-gb-04');
    const panel = await openPanel(page);
    await panelUi.option(panel, '가').check();
    await panelUi.submit(panel).click();
    const explanation = panel.getByText(EXPLANATION);
    await expect(explanation).toBeVisible();
    // The nearest ancestor with a fill: the text sits in unfilled wrappers inside the area.
    const fill = () =>
      explanation.evaluate((element) => {
        for (let node = element.parentElement; node; node = node.parentElement) {
          const color = getComputedStyle(node).backgroundColor;
          if (color !== 'rgba(0, 0, 0, 0)') return { color, panel: node.matches('.qz-panel') };
        }
        return null;
      });

    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const muted = await tokenColor(page, '--color-surface-muted');
      await expect.poll(fill).toEqual({ color: muted, panel: false });
    }
  },
);

test(
  'UX12-GLASSBTN-AC05 icon-only buttons of every variant drop the border, toggles keep it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { ws } = await openOverview(page, workspaceFactory, 'ux12-gb-05');
    const panel = await openPanel(page);
    const favorite = panelUi.favoriteOn(panel);
    await expect(favorite).toBeVisible();
    expect((await surfaceOf(favorite)).border).not.toBe(TRANSPARENT);
    await panelUi.close(panel).click();

    await page.goto(homePath(ws.id));
    const history = page.getByRole('button', { name: /^(이력|history)$/i });
    await expect(history).toBeVisible();
    const style = await surfaceOf(history);
    expect(style.border).toBe(TRANSPARENT);
    expect(style.borderWidth).toBe('1px');
    const box = await history.boundingBox();
    expect(box?.width).toBe(36);
    expect(box?.height).toBe(36);
  },
);

test(
  'UX12-GLASSBTN-AC06 a heatmap cell scales its marker by 1.5 without moving the grid',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    await openOverview(page, workspaceFactory, 'ux12-gb-06');
    const dot = overviewUi.dot(page, 1);
    await expect(dot).toBeVisible();
    const before = await dot.boundingBox();
    await dot.hover();
    const marker = dot.locator('.qz-question-marker');
    await expect
      .poll(() => marker.evaluate((el) => getComputedStyle(el).transform))
      .toContain('matrix(1.5, 0, 0, 1.5');
    expect(await dot.boundingBox()).toEqual(before);
    const clipped = await dot.evaluate((element) => {
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (node.tagName === 'MAIN') return null;
        const { overflowX, overflowY } = getComputedStyle(node);
        if (overflowX === 'hidden' || overflowY === 'hidden') return node.className;
      }
      return null;
    });
    expect(clipped).toBeNull();
  },
);

test(
  'UX12-GLASSBTN-AC07 the sticky home toolbar is translucent and blurs what passes behind it',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const { ws } = await openOverview(page, workspaceFactory, 'ux12-gb-07');
    await page.goto(homePath(ws.id));
    const history = page.getByRole('button', { name: /^(이력|history)$/i });
    await expect(history).toBeVisible();
    const toolbar = await history.evaluateHandle((element) => {
      let node: Element | null = element;
      while (node && getComputedStyle(node).position !== 'sticky') node = node.parentElement;
      return node;
    });
    const style = await toolbar.evaluate((element) => {
      if (!(element instanceof Element)) return null;
      const css = getComputedStyle(element);
      return {
        color: css.backgroundColor,
        blur: css.backdropFilter || css.getPropertyValue('-webkit-backdrop-filter'),
      };
    });
    expect(style?.blur).toMatch(BLUR);
    expect(style?.color).not.toMatch(OPAQUE);
  },
);

test(
  'UX12-GLASSBTN-AC08 a confirm dialog has no divider above its actions',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-gb-08');
    const name = uniqueWorkspaceName('ux12-gb-08');
    await workspaceFactory.create(owner, name);
    await signInAs(page, owner.user);
    await page.goto('/workspaces');
    await chooseWorkspaceAction(page, wsUi.item(wsUi.tabPanel(page), name), DELETE_ACTION);
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    const lines = await dialog.locator('> .header, > .footer').evaluateAll((items) =>
      items.map((element) => {
        const css = getComputedStyle(element);
        return [css.borderTopWidth, css.borderBottomWidth, css.paddingBottom];
      }),
    );
    expect(lines.map(([top, bottom]) => [top, bottom])).toEqual([
      ['0px', '0px'],
      ['0px', '0px'],
    ]);
    expect(lines[1]?.[2]).toBe('12px');
  },
);

test(
  'UX12-GLASSBTN-AC09 the ask composer is a glass surface',
  { tag: '@infra' },
  async ({ page, workspaceFactory }) => {
    const owner = await workspaceFactory.member('ux12-gb-09');
    const ws = await workspaceFactory.create(owner);
    await signInAs(page, owner.user);
    await page.goto(homePath(ws.id));
    const panel = await openAskPanel(page);
    await openComposer(panel);
    const composer = panel.locator('.glass-surface').filter({ has: page.getByRole('textbox') });
    await expect(composer).toHaveCount(1);
    expect((await surfaceOf(composer)).blur).toMatch(BLUR);
  },
);
