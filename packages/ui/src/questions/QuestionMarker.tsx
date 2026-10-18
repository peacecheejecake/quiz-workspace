import { cx } from '../internal/cx';
import type { QuestionDotStatus } from './status';

export interface QuestionMarkerProps {
  status: QuestionDotStatus;
  /** Favorite swaps the rounded square for a rounded star of the same size and color. */
  favorite?: boolean;
  /**
   * `data-testid` of the marker. Heatmap dots keep the default (`question-marker`, which the
   * QOV-01 E2E specs count); decorative copies (legend, summary, preview) pass `null` so they
   * never inflate the marker count.
   */
  testId?: string | null;
  className?: string;
}

/** The SVG of docs/design-system.md §6.1. `status` undefined renders a neutral marker. */
export function MarkerShape({
  status,
  favorite = false,
  testId,
  className,
}: Omit<QuestionMarkerProps, 'status'> & { status?: QuestionDotStatus }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cx('qz-question-marker', className)}
      data-testid={testId ?? undefined}
      data-shape={favorite ? 'star' : 'square'}
      data-status={status}
      aria-hidden="true"
      focusable="false"
    >
      {favorite ? (
        <path
          className="qz-question-marker__shape"
          d="M12 2.5 15.1 8.5 21.6 9.45 16.8 14.1 17.95 20.65 12 17.5 6.05 20.65 7.2 14.1 2.4 9.45 8.9 8.5Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : (
        <rect
          className="qz-question-marker__shape"
          x="3"
          y="3"
          width="18"
          height="18"
          rx="4.5"
          fill="currentColor"
        />
      )}
    </svg>
  );
}

/**
 * Status marker (decorative, `aria-hidden`): fill = `--question-status-<status>` via
 * `data-status`, plus a darker/lighter outline of the same hue so light markers (unseen, retry)
 * stay ≥ 3:1 against the surface. Meaning is always also given as text (label, legend, tooltip).
 */
export function QuestionMarker({ testId = 'question-marker', ...props }: QuestionMarkerProps) {
  return <MarkerShape testId={testId} {...props} />;
}
