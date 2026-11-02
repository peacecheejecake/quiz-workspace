// DOCVIEW-01: the split area takes the viewport height left over by the rest of the page, so the
// DOC-02 document screen and the WS-VIEW-01 shared document view fit the viewport exactly (no page
// scroll on top of the panes' own scroll) whatever sits above the area (title, notices, the 보기
// 설정 bar) or below it (page padding).
//
// The page's containers are not a height-constrained flex chain (the app shell and the shared view
// grow with their content), so the space around the area is measured instead: the area's offset
// from the top of the document plus the in-flow content and padding below it up to <body>. Both
// are independent of the area's own height (content below moves with it), so the result is a
// fixed point, and stretched containers (`min-height: 100dvh`) do not feed back into it.

/** The CSS custom property the area's height is computed from (see viewer-layout.module.css). */
export const VIEWER_CHROME_PROPERTY = '--viewer-area-chrome';

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function inFlow(el: Element): boolean {
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.position !== 'absolute' && style.position !== 'fixed';
}

/** A box's vertical extent in viewport px: border-box top, bottom including its bottom margin. */
export interface VerticalExtent {
  readonly top: number;
  readonly bottom: number;
}

/** Sub-pixel layout noise allowed when deciding that a sibling starts below the element. */
const FOLLOW_TOLERANCE = 0.5;

/**
 * How far content that vertically FOLLOWS an element (`nodeBottom`) reaches below it, among its
 * siblings. Siblings that start above the element's bottom are earlier rows or parallel columns
 * (e.g. the shared view's sidebar beside the viewer): they never count, so the result moves with
 * the element and does not depend on its height — the measurement stays a fixed point.
 */
export function trailingExtent(nodeBottom: number, siblings: readonly VerticalExtent[]): number {
  let bottom = nodeBottom;
  for (const sibling of siblings) {
    if (sibling.top < nodeBottom - FOLLOW_TOLERANCE) continue;
    bottom = Math.max(bottom, sibling.bottom);
  }
  return bottom - nodeBottom;
}

/** Vertical space the page takes besides `area`: its document offset plus what follows it. */
export function pageChromeAround(area: HTMLElement): number {
  const areaRect = area.getBoundingClientRect();
  const top = areaRect.top + window.scrollY;
  let below = 0;
  let node: HTMLElement = area;
  let nodeBottom = areaRect.bottom + px(getComputedStyle(area).marginBottom);
  for (let parent = node.parentElement; parent; parent = node.parentElement) {
    const siblings: VerticalExtent[] = [];
    for (const child of Array.from(parent.children)) {
      if (child === node || !inFlow(child)) continue;
      const rect = child.getBoundingClientRect();
      if (rect.height === 0 && rect.width === 0) continue;
      siblings.push({
        top: rect.top,
        bottom: rect.bottom + px(getComputedStyle(child).marginBottom),
      });
    }
    const trailing = trailingExtent(nodeBottom, siblings);
    const style = getComputedStyle(parent);
    const edge = px(style.paddingBottom) + px(style.borderBottomWidth);
    below += trailing + edge;
    if (parent === document.body || parent === document.documentElement) break;
    // The parent's bottom as far as this chain is concerned: content after the area plus its own
    // padding, never a parallel column or a min-height stretch.
    nodeBottom += trailing + edge + px(style.marginBottom);
    node = parent;
  }
  return Math.ceil(top + below);
}

/** Keeps `--viewer-area-chrome` on `area` up to date; returns the cleanup. */
export function fitAreaToViewport(area: HTMLElement): () => void {
  let frame = 0;
  const update = () => {
    frame = 0;
    area.style.setProperty(VIEWER_CHROME_PROPERTY, `${pageChromeAround(area)}px`);
  };
  const schedule = () => {
    if (frame === 0) frame = window.requestAnimationFrame(update);
  };
  update();
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  // Content-sized ancestors resize when anything above or below the area changes (a notice
  // appears, fonts load); <body> also follows the viewport.
  for (let el = area.parentElement; el; el = el.parentElement) {
    observer?.observe(el);
    if (el === document.body) break;
  }
  window.addEventListener('resize', schedule);
  return () => {
    observer?.disconnect();
    window.removeEventListener('resize', schedule);
    if (frame !== 0) window.cancelAnimationFrame(frame);
  };
}
