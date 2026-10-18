import type { Meta, StoryObj } from '@storybook/react-vite';
import type { CSSProperties } from 'react';
import { fn } from 'storybook/test';
import { QuestionDot } from './QuestionDot';
import { QUESTION_DOT_STATUSES, questionStatusLabels } from './status';

const meta = {
  title: 'Questions/QuestionDot',
  component: QuestionDot,
  args: {
    questionId: 'q-3-12',
    status: 'correct',
    isFavorite: false,
    questionNumber: '12',
    questionType: 'MCQ',
    chapterTitle: '어텐션',
    chapterNumber: 3,
    preview: 'Scaled dot-product attention에서 키 차원의 제곱근으로 나누는 이유를 고르시오.',
    isSelected: false,
    onOpen: fn(),
    onPreview: fn(),
  },
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'One CONFIRMED question: a 28×28px `<button>` (32px on mobile/coarse pointers) ' +
          'centering a 16px QuestionMarker. Favorite swaps the rounded square for a rounded star ' +
          'of the same size and color. Only the marker scales (`--heatmap-marker-hover-scale`) on ' +
          'hover (hover-capable pointers only) and `:focus-visible`; the cell never moves. ' +
          'Selected = accent ring, color unchanged. Keyboard: Enter/Space open (`onOpen`), focus ' +
          'shows the preview, Escape closes it. Hover/focus preview never marks the question ' +
          'viewed. Label: `3장 12번 문제, 객관식, 마지막 결과 오답, 다시 풀기 표시됨, 즐겨찾기`. ' +
          'Tokens: --question-status-*, --color-text-primary (outline mix), --color-focus, ' +
          '--color-accent, --heatmap-cell(-touch), --heatmap-dot, --duration-marker.',
      },
    },
  },
} satisfies Meta<typeof QuestionDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Favorite: Story = { args: { isFavorite: true } };
export const Selected: Story = { args: { isSelected: true } };
export const RetryOverIncorrect: Story = {
  args: { status: 'retry', lastGradedResult: 'incorrect', isFavorite: true },
};
export const PendingGrading: Story = {
  args: { status: 'viewed', questionType: 'ESSAY', isPendingGrading: true },
};
export const PreviewOpen: Story = {
  parameters: { docs: { story: { height: '220px' } } },
  play: async ({ canvas, userEvent }) => {
    await userEvent.hover(canvas.getByRole('button'));
  },
};

const COLUMNS = [
  { key: 'default', label: 'default' },
  { key: 'hover', label: 'hover' },
  { key: 'focus', label: 'focus-visible' },
  { key: 'selected', label: 'selected' },
] as const;

const cell: CSSProperties = { padding: 'var(--space-1) var(--space-2)', textAlign: 'center' };

/**
 * docs/design-system.md §8: 5 statuses × favorite (square/star) × default/hover/focus/selected.
 * Hover and focus are forced with storybook-addon-pseudo-states; this story is also the visual
 * regression baseline (`pnpm --filter @quiz/ui test:visual`).
 */
export const StateMatrix: Story = {
  parameters: {
    pseudo: {
      hover: ['[data-col="hover"] .qz-question-dot'],
      focusVisible: ['[data-col="focus"] .qz-question-dot'],
    },
  },
  render: (args) => (
    <table
      data-testid="state-matrix"
      style={{
        borderCollapse: 'collapse',
        color: 'var(--color-text-primary)',
        fontSize: 'var(--font-size-label)',
        background: 'var(--color-surface)',
      }}
    >
      <thead>
        <tr>
          <th style={cell} scope="col">
            상태
          </th>
          {COLUMNS.map((col) => (
            <th key={col.key} style={cell} scope="colgroup" colSpan={2}>
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {QUESTION_DOT_STATUSES.map((status) => (
          <tr key={status}>
            <th scope="row" style={{ ...cell, textAlign: 'left' }}>
              {questionStatusLabels[status]}
            </th>
            {COLUMNS.flatMap((col) =>
              [false, true].map((favorite) => (
                <td key={`${col.key}-${favorite}`} style={cell} data-col={col.key}>
                  <QuestionDot
                    {...args}
                    questionId={`${status}-${col.key}-${favorite}`}
                    status={status}
                    isFavorite={favorite}
                    isSelected={col.key === 'selected'}
                    data-testid={`dot-${status}-${favorite ? 'star' : 'square'}-${col.key}`}
                  />
                </td>
              )),
            )}
          </tr>
        ))}
      </tbody>
    </table>
  ),
};
