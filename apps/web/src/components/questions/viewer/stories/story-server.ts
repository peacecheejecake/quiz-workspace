// Storybook stand-ins for the server actions the QuestionViewer modes call
// (lib/questions/practice-actions.ts, lib/questions/actions.ts). packages/ui/.storybook/main.ts
// aliases those modules here for the viewer stories only; the app never imports this file.
// Synthetic content only.
import type { PracticeSession, SubmitResult } from '@/lib/questions/practice-actions';

export const STORY_SESSION: PracticeSession = {
  id: '99999999-9999-4999-8999-000000000001',
  workspace_id: '55555555-5555-4555-8555-555555555555',
  question_id: '22222222-2222-4222-8222-000000000001',
  question_revision_id: '77777777-7777-4777-8777-000000000001',
  question_number: 12,
  question_type: 'MCQ',
  chapter_id: null,
  stem: '물이 액체에서 기체로 변하는 현상으로 알맞은 것은? ( )',
  is_multi_answer: false,
  displayed_option_ids: ['o2', 'o1', 'o3'],
  options: [
    { id: 'o2', text: '응결' },
    { id: 'o1', text: '증발' },
    { id: 'o3', text: '강수' },
  ],
  state: 'open',
  opened_at: '2026-11-02T00:00:00Z',
};

export const STORY_RESULT: SubmitResult = {
  attempt_id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  practice_session_id: STORY_SESSION.id,
  question_revision_id: STORY_SESSION.question_revision_id,
  state: 'graded',
  result: 'incorrect',
  correct_option_ids: ['o1'],
  accepted_answers: null,
  explanation: '증발은 액체 표면에서 물 분자가 기체가 되어 날아가는 현상이다.',
  rubric: null,
};

const ok = <T>(data: T) => Promise.resolve({ ok: true as const, data });

export const openPracticeSessionAction = () => ok(STORY_SESSION);
export const submitPracticeAction = () => ok(STORY_RESULT);
export const selfGradePracticeAction = () =>
  ok({ attempt_id: STORY_RESULT.attempt_id, practice_session_id: STORY_SESSION.id });
export const setMyStateAction = (_ws: string, _q: string, flags: object) =>
  ok({ is_favorite: false, needs_retry: false, last_graded_result: null, ...flags });
export const lookupOverviewQuestionAction = () => ok(null);
export const getQuestionAction = () =>
  Promise.resolve({ ok: false as const, kind: 'notFound', message: '없음' });
export const getQuestionRevisionAction = () =>
  Promise.resolve({ ok: false as const, kind: 'notFound', message: '없음' });
