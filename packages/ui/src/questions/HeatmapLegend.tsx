import type { HTMLAttributes } from 'react';
import { cx } from '../internal/cx';
import { MarkerShape } from './QuestionMarker';
import { QUESTION_DOT_STATUSES, questionStatusLabels } from './status';

export interface HeatmapLegendProps extends Omit<HTMLAttributes<HTMLUListElement>, 'children'> {
  /** Accessible name of the legend list. */
  label?: string;
}

/**
 * Always-visible legend: the five status colors with their Korean names and the favorite star
 * (shape, not color), so the heatmap never relies on color alone.
 */
export function HeatmapLegend({ label = '상태 범례', className, ...rest }: HeatmapLegendProps) {
  return (
    <ul aria-label={label} className={cx('qz-heatmap-legend', className)} {...rest}>
      {QUESTION_DOT_STATUSES.map((status) => (
        <li key={status} className="item">
          <MarkerShape status={status} />
          <span>{questionStatusLabels[status]}</span>
        </li>
      ))}
      <li className="item">
        <MarkerShape favorite />
        <span>즐겨찾기</span>
      </li>
    </ul>
  );
}
