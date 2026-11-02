'use client';

// QVIEW-01 `QuestionViewer` (docs/screens/question-viewer.md, questions.md §12, design-system §5.1):
// the one component every place that shows questions one at a time uses (user decision MOCK 6,
// 2026-11-01). What the existing screens require — modal or not, answers shown or not, previous /
// next order — stays as the mode:
//   practice   a Heatmap marker / `?question=` (history and 정리 노트 links too): modal panel, one
//              question, a practice session, previous/next in Heatmap order (QPLAY-01)
//   sequence   a range run (`문제 › 문제 풀기`, a mock exam's `풀기`): modal panel, range step,
//              progress, results (QVIEW-01)
//   manage     the 문제 상세 dialog over the practice panel or a 보관·초안 문제 row: answers,
//              sources and revision history, the opener's actions; no submit UI (UX7-BANK-2)
//   read-only  a share-link guest's preview: non-modal panel, answers shown, nothing recorded
// Every mode renders its question through QuestionBody (`displayStem`, the hidden 보기 label, the
// grading border of an answered MCQ — QPLAY-01-AC12/AC13).
import { ManageViewer, type ManageViewerProps } from './manage-viewer';
import { PracticeViewer, type PracticeViewerProps } from './practice-viewer';
import { ReadOnlyViewer, type ReadOnlyViewerProps } from './read-only-viewer';
import { SequenceViewer, type SequenceViewerProps } from './sequence-viewer';

export type QuestionViewerMode = 'practice' | 'sequence' | 'manage' | 'read-only';

export type QuestionViewerProps =
  | ({ readonly mode: 'practice' } & PracticeViewerProps)
  | ({ readonly mode: 'sequence' } & SequenceViewerProps)
  | ({ readonly mode: 'manage' } & ManageViewerProps)
  | ({ readonly mode: 'read-only' } & ReadOnlyViewerProps);

export function QuestionViewer(props: QuestionViewerProps) {
  switch (props.mode) {
    case 'practice': {
      const { mode: _mode, ...rest } = props;
      return <PracticeViewer {...rest} />;
    }
    case 'sequence': {
      const { mode: _mode, ...rest } = props;
      return <SequenceViewer {...rest} />;
    }
    case 'manage': {
      const { mode: _mode, ...rest } = props;
      return <ManageViewer {...rest} />;
    }
    case 'read-only': {
      const { mode: _mode, ...rest } = props;
      return <ReadOnlyViewer {...rest} />;
    }
  }
}

export type { DetailFocus, ManageLoad } from './manage-viewer';
export type { Invalidation, PracticeQuestion } from './practice-viewer';
export type { ReadOnlyQuestion } from './read-only-viewer';
export type { RunClient, RunQuestionInfo } from './sequence-viewer';
export { bankRunClient } from './sequence-viewer';
