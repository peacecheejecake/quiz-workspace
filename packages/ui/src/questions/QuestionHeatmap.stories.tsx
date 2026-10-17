import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { HeatmapLegend } from './HeatmapLegend';
import { QuestionHeatmap } from './QuestionHeatmap';
import { sampleChapters } from './story-data';
import { StatusSummary } from './StatusSummary';
import { summarizeStatuses } from './status';
import { FavoriteToggle, RetryToggle } from './StudyToggles';

const FULL = sampleChapters();

const meta = {
  title: 'Questions/QuestionHeatmap',
  component: QuestionHeatmap,
  args: { chapters: FULL, onOpen: fn(), onPreview: fn(), selectedQuestionId: 'q-2-5' },
  parameters: {
    docs: {
      description: {
        component:
          'Chapter-grouped grid of QuestionDots (one per CONFIRMED question). Fixed 28px cells ' +
          '(32px on mobile/coarse pointers), 4px gap, columns follow the width. Keyboard: a ' +
          'single roving tab stop; Arrow keys move between dots (Up/Down by visual row, across ' +
          'chapters), Home/End = first/last in the chapter, Ctrl+Home/End = whole heatmap, ' +
          'Enter/Space open. Hover/focus opens the preview after ~200ms; `onPreview` is ' +
          'informational and must never mark a question viewed. Not virtualized (review beyond ' +
          '~2,000 questions). Wrong usage: hard-coded status hex, color-only status without the ' +
          'legend/summary, scaling the cell instead of the marker.',
      },
    },
  },
} satisfies Meta<typeof QuestionHeatmap>;

export default meta;
type Story = StoryObj<typeof meta>;

/** ~200 questions in 8 chapters. */
export const Full: Story = {};

export const FullDark: Story = { globals: { theme: 'dark' } };

export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  args: { chapters: sampleChapters([18, 12]) },
};

export const SmallChapters: Story = { args: { chapters: sampleChapters([3, 0, 5]) } };

function OverviewDemo() {
  const [selected, setSelected] = useState<string | null>(null);
  const [favorite, setFavorite] = useState(false);
  const [retry, setRetry] = useState(false);
  const counts = summarizeStatuses(FULL.flatMap((c) => c.questions));
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)', maxWidth: 960 }}>
      <StatusSummary counts={counts} />
      <QuestionHeatmap chapters={FULL} selectedQuestionId={selected} onOpen={setSelected} />
      <HeatmapLegend />
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
        <span>{selected ?? '문제를 선택하세요'}</span>
        <FavoriteToggle pressed={favorite} onPressedChange={setFavorite} />
        <RetryToggle pressed={retry} onPressedChange={setRetry} />
      </div>
    </div>
  );
}

/** Summary chips + heatmap + legend + panel-header toggles, as QOV-01 composes them. */
export const OverviewComposition: Story = { render: () => <OverviewDemo /> };
export const OverviewCompositionDark: Story = {
  globals: { theme: 'dark' },
  render: () => <OverviewDemo />,
};
