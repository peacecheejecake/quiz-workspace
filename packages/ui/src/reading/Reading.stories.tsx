import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { findInNote } from './find-in-note';
import { HighlightableText } from './HighlightableText';
import { HighlightMenu } from './HighlightMenu';
import type {
  HighlightAction,
  HighlightSelection,
  SelectionSource,
  TextBlock,
  TextHighlight,
} from './model';
import { PointerAnchoredFloating } from './PointerAnchoredFloating';
import { SearchField } from './SearchField';

const footnote = (n: number) => (
  <a href={`#fn-${n}`} aria-label={`각주 ${n}`} style={{ marginInlineStart: 'var(--space-1)' }}>
    [{n}]
  </a>
);

const BLOCKS: TextBlock[] = [
  {
    id: 's0.i0',
    text: '증발은 액체가 기체로 바뀌는 과정이며, 주의할 점은 온도와 압력이다.',
    suffix: footnote(1),
  },
  {
    id: 's0.i1',
    text: '응축은 기체가 액체로 바뀌는 과정이다. 주의: 순서를 묻는 문제가 자주 나온다.',
    emphasis: [{ start: 0, end: 2, kind: 'strong' }],
    suffix: footnote(2),
  },
  { id: 's1.i0', text: '강수와 유출이 이어지며 물의 순환이 완성된다.', suffix: footnote(3) },
];

const HIGHLIGHTS: TextHighlight[] = [
  { id: 'h1', block: 's0.i0', start: 0, end: 2, color: 'yellow' },
  { id: 'h2', block: 's0.i0', start: 22, end: 32, color: 'blue' },
  { id: 'h3', block: 's0.i1', start: 0, end: 21, color: 'pink' },
];

function apply(list: TextHighlight[], action: HighlightAction): TextHighlight[] {
  if (action.type === 'remove') return list.filter((h) => !action.ids.includes(h.id));
  if (action.type === 'recolor') {
    return list.map((h) => (h.id === action.id ? { ...h, color: action.color } : h));
  }
  const rest = list.filter((h) => !action.replaceIds.includes(h.id));
  return [...rest, { id: `h${Date.now()}`, ...action }];
}

function NoteLayout({
  readOnly,
  initial = HIGHLIGHTS,
  query = '',
}: {
  readOnly?: boolean;
  initial?: TextHighlight[];
  query?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [highlights, setHighlights] = useState(initial);
  const [selection, setSelection] = useState<HighlightSelection | null>(null);
  const matches = useMemo(
    () => findInNote(BLOCKS, query).matches.map((m, i) => ({ ...m, current: i === 1 })),
    [query],
  );
  return (
    <div style={{ maxWidth: 520 }}>
      <HighlightableText
        ref={ref}
        label="정리 노트 본문"
        blocks={BLOCKS}
        highlights={highlights}
        matches={matches}
        readOnly={readOnly}
        onSelectRange={setSelection}
        activeHighlightId={selection?.highlightId}
        renderLayout={(block) => (
          <>
            <h3 style={{ margin: 0 }}>증발과 응축</h3>
            <ul>
              {block('s0.i0', { as: 'li' })}
              {block('s0.i1', { as: 'li' })}
            </ul>
            <h3 style={{ margin: 0 }}>강수</h3>
            <ul>{block('s1.i0', { as: 'li' })}</ul>
          </>
        )}
      />
      <HighlightMenu
        selection={selection}
        highlights={highlights}
        readOnly={readOnly}
        returnFocusTo={ref}
        onClose={() => setSelection(null)}
        onAction={(action) => setHighlights((list) => apply(list, action))}
      />
    </div>
  );
}

const meta = {
  title: 'Reading/HighlightableText',
  component: HighlightableText,
  args: { label: '정리 노트 본문', blocks: BLOCKS },
  parameters: {
    docs: {
      description: {
        component:
          'Shared highlight tool (design-system §5.2, HILITE-01): `HighlightableText` draws ' +
          'highlights (background + solid/double/dotted underline per color, hidden start/end ' +
          'labels) and search results (border, drawn above highlights; the current one thicker ' +
          'with hidden "현재 결과") and reports selections as block offsets; `HighlightMenu` is ' +
          'the menu next to the selection. Select text with the mouse, long-press on touch, or ' +
          'Tab into the area, use ArrowUp/ArrowDown and press Shift+F10 / ContextMenu / Enter.',
      },
    },
  },
} satisfies Meta<typeof HighlightableText>;

export default meta;
type Story = StoryObj<typeof meta>;

/** All three colors; select text to open the menu (merge, recolor, remove, copy). */
export const ThreeColors: Story = { render: () => <NoteLayout /> };

/** Search results over plain text and over highlights ("주의"; the second result is current). */
export const SearchOverHighlights: Story = { render: () => <NoteLayout query="주의" /> };

/** Read-only: no pressable highlights, the menu offers only `복사`. */
export const ReadOnly: Story = { render: () => <NoteLayout readOnly /> };

/** Dark theme. */
export const Dark: Story = {
  render: () => <NoteLayout query="주의" />,
  globals: { theme: 'dark' },
};

/**
 * Forced colors (Windows High Contrast): emulate `forced-colors: active` in the browser devtools
 * (Rendering panel). Highlights become `Mark`/`MarkText` with their underline shapes kept; search
 * results get a `CanvasText` border (current: `Highlight`).
 */
export const ForcedColors: Story = {
  render: () => <NoteLayout query="주의" />,
  parameters: { docs: { description: { story: 'Emulate forced-colors in devtools.' } } },
};

/** The menu opened from the keyboard for the whole second item (Shift+F10 on it). */
function OpenMenu({ source, block }: { source: SelectionSource; block: TextBlock }) {
  const ref = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<HighlightSelection | null>(null);
  useEffect(() => {
    const el = ref.current?.querySelector(`[data-hl-block="${block.id}"]`);
    if (!el) return;
    setSelection({
      block: block.id,
      start: 0,
      end: block.text.length,
      text: block.text,
      source,
      getAnchorRect: () => {
        const box = el.getBoundingClientRect();
        // Touch anchors to the end of the selection.
        return source === 'touch' ? new DOMRect(box.right - 1, box.top, 1, box.height) : box;
      },
      restore: () => undefined,
    });
  }, [block, source]);
  return (
    <div style={{ maxWidth: 480, paddingTop: 160 }}>
      <HighlightableText
        ref={ref}
        label="정리 노트 본문"
        blocks={BLOCKS}
        highlights={HIGHLIGHTS}
        onSelectRange={setSelection}
      />
      <HighlightMenu
        selection={selection}
        highlights={HIGHLIGHTS}
        returnFocusTo={ref}
        onClose={() => setSelection(null)}
      />
    </div>
  );
}

const SECOND = BLOCKS[1] as TextBlock;
const THIRD = BLOCKS[2] as TextBlock;

/** Keyboard paragraph menu: the whole item; `하이라이트 지우기` because it overlaps a highlight. */
export const KeyboardBlockMenu: Story = {
  render: () => <OpenMenu source="keyboard" block={SECOND} />,
};

/** Touch: the menu sits below the end of the selection, clear of the OS selection menu. */
export const TouchPlacement: Story = {
  render: () => <OpenMenu source="touch" block={THIRD} />,
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};

/** design-system §5.4: footnote preview hung from the pointer (tap opens a dialog on touch). */
export const FootnotePreview: Story = {
  render: () => (
    <p style={{ maxWidth: 480 }}>
      증발은 액체가 기체로 바뀌는 과정이다.
      <PointerAnchoredFloating
        label="문제 미리보기"
        openOnTap
        content={({ mode }) => (
          <div>
            <strong>1장 3번 · 객관식</strong>
            <p style={{ margin: 'var(--space-2) 0' }}>다음 중 증발에 대한 설명으로 옳은 것은?</p>
            <ol style={{ margin: 0, paddingInlineStart: 'var(--space-5)' }}>
              <li>액체가 기체로 바뀐다.</li>
              <li>기체가 액체로 바뀐다.</li>
            </ol>
            {mode === 'tap' ? <button type="button">문제 열기</button> : null}
          </div>
        )}
      >
        <a href="#q3" aria-label="각주 1">
          [1]
        </a>
      </PointerAnchoredFloating>
    </p>
  ),
};

function SearchDemo() {
  const [value, setValue] = useState('');
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const { matches, capped } = useMemo(() => findInNote(BLOCKS, query), [query]);
  const total = matches.length;
  return (
    <div style={{ maxWidth: 520, display: 'grid', gap: 'var(--space-3)' }}>
      <SearchField
        label="노트에서 찾기"
        value={value}
        onValueChange={setValue}
        onSearch={(q) => {
          setQuery(q);
          setCurrent(findInNote(BLOCKS, q).matches.length > 0 ? 1 : 0);
        }}
        total={total}
        current={current}
        capped={capped}
        onNext={() => setCurrent((c) => (c >= total ? 1 : c + 1))}
        onPrevious={() => setCurrent((c) => (c <= 1 ? total : c - 1))}
      />
      <HighlightableText
        label="정리 노트 본문"
        blocks={BLOCKS}
        highlights={HIGHLIGHTS}
        matches={matches.map((m, i) => ({ ...m, current: i === current - 1 }))}
      />
    </div>
  );
}

/** CHNOTE-02 search row: type "주의"; Enter / Shift+Enter step, Escape clears. */
export const NoteSearch: Story = { render: () => <SearchDemo /> };
