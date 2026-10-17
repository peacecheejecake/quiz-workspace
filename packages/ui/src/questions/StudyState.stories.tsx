import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { HeatmapLegend } from './HeatmapLegend';
import { QuestionMarker } from './QuestionMarker';
import { StatusSummary } from './StatusSummary';
import { QUESTION_DOT_STATUSES, summarizeStatuses } from './status';
import { FavoriteToggle, RetryToggle } from './StudyToggles';

const counts = summarizeStatuses([
  ...Array.from({ length: 201 }, () => ({ status: 'unseen' as const, isFavorite: false })),
  ...Array.from({ length: 79 }, (_, i) => ({ status: 'viewed' as const, isFavorite: i < 4 })),
  ...Array.from({ length: 42 }, (_, i) => ({ status: 'incorrect' as const, isFavorite: i < 6 })),
  ...Array.from({ length: 96 }, (_, i) => ({ status: 'correct' as const, isFavorite: i < 9 })),
  ...Array.from({ length: 18 }, (_, i) => ({ status: 'retry' as const, isFavorite: i < 3 })),
]);

const meta = {
  title: 'Questions/Study state',
  component: StatusSummary,
  args: { counts },
  parameters: {
    docs: {
      description: {
        component:
          'StatusSummary: count chips (전체, five mutually exclusive statuses, 즐겨찾기 overlap); ' +
          'one horizontally scrollable row below 768px. HeatmapLegend: always-visible status ' +
          'names + favorite star. QuestionMarker: decorative SVG (aria-hidden), status color ' +
          'via data-status, ≥3:1 outline. FavoriteToggle/RetryToggle: IconButtons whose label ' +
          'names the action (`즐겨찾기 추가`/`즐겨찾기 해제`, `다시 풀기 표시`/`다시 풀기 해제`).',
      },
    },
  },
} satisfies Meta<typeof StatusSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Summary: Story = {};
export const SummaryMobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
export const Legend: Story = { render: () => <HeatmapLegend /> };
export const LegendDark: Story = { globals: { theme: 'dark' }, render: () => <HeatmapLegend /> };

export const Markers: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
      {QUESTION_DOT_STATUSES.flatMap((status) => [
        <QuestionMarker key={status} status={status} />,
        <QuestionMarker key={`${status}-star`} status={status} favorite />,
      ])}
    </div>
  ),
};

function TogglesDemo() {
  const [favorite, setFavorite] = useState(false);
  const [retry, setRetry] = useState(true);
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
      <FavoriteToggle pressed={favorite} onPressedChange={setFavorite} />
      <RetryToggle pressed={retry} onPressedChange={setRetry} />
      <FavoriteToggle pressed onPressedChange={() => undefined} disabled />
    </div>
  );
}

export const Toggles: Story = { render: () => <TogglesDemo /> };
