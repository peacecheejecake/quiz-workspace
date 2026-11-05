// MOCK-01 모의고사 dialog stories (docs/screens/mock-exams.md): the empty list, a list with every
// status, 만들기 (options step, with and without the AI types), and the detail while it is made,
// failed, partly made and ready — each in light and dark. Built by the @quiz/ui Storybook
// (packages/ui/.storybook/main.ts); a fake MockExamApi answers, nothing reaches the network.
// Synthetic content only, and no answers: the detail is the viewer's (answer-free) one.
import type { ComponentProps } from 'react';
import type { MockExamApi, MockResult } from './mock-exam-client';
import type { MockExam, MockExamGeneration, MockExamQuestion } from './mock-exam-model';
import { MockExamsPanel } from './mock-exams-panel';

type Props = ComponentProps<typeof MockExamsPanel>;
interface Story {
  readonly args: Props;
  readonly globals?: { readonly theme: 'light' | 'dark' };
}

const WS = '55555555-5555-4555-8555-555555555555';
const noop = () => undefined;
const ok = <T,>(data: T): Promise<MockResult<T>> => Promise.resolve({ ok: true, data });

function generation(overrides: Partial<MockExamGeneration> = {}): MockExamGeneration {
  return {
    id: '66666666-6666-4666-8666-000000000001',
    version: 2,
    status: 'succeeded',
    job_id: null,
    requested_count: 20,
    created_count: 20,
    skipped_count: 0,
    error_code: null,
    progress: null,
    seed: 1,
    created_at: '2026-11-01T06:28:00Z',
    finished_at: '2026-11-01T06:29:00Z',
    ...overrides,
  };
}

function exam(id: number, overrides: Partial<MockExam> = {}): MockExam {
  return {
    id: `44444444-4444-4444-8444-00000000000${id}`,
    workspace_id: WS,
    title: `중간 점검 ${id}`,
    version: 1,
    status: 'ready',
    config: { variation_types: ['PARAPHRASE', 'INVERT_POLARITY'], question_count: 20 },
    range: { all: true, chapter_ids: [], question_ids: [], excluded_question_ids: [] },
    question_count_current: 20,
    current_generation: generation(),
    latest_generation: generation(),
    created_at: '2026-11-01T06:28:00Z',
    updated_at: '2026-11-01T06:29:00Z',
    ...overrides,
  };
}

const READY = exam(1);
const GENERATING = exam(2, {
  status: 'generating',
  question_count_current: 0,
  current_generation: null,
  latest_generation: generation({ status: 'running', progress: { done: 7, total: 20 } }),
});
const PARTIAL = exam(3, {
  status: 'partial',
  question_count_current: 17,
  latest_generation: generation({ status: 'partial', created_count: 17, skipped_count: 3 }),
});
const FAILED = exam(4, {
  status: 'failed',
  latest_generation: generation({ version: 3, status: 'failed', error_code: 'llm_unavailable' }),
});

const QUESTIONS: MockExamQuestion[] = [1, 2, 3].map((k) => ({
  id: `77777777-7777-4777-8777-00000000000${k}`,
  position: k,
  question_type: 'MCQ',
  variation_type: k === 2 ? 'INVERT_POLARITY' : 'PARAPHRASE',
  stem: `물의 순환에서 ${['증발', '응결', '강수'][k - 1]}에 대한 설명으로 알맞은 것은? ( )`,
  options: [
    { id: 'a', text: '보기 하나' },
    { id: 'b', text: '보기 둘' },
  ],
  is_multi_answer: false,
  revision: { id: `88888888-8888-4888-8888-00000000000${k}`, version: 1 },
  edited: false,
  source: { question_id: null, label: `1장 ${k}번` },
}));

function api(exams: readonly MockExam[], llmAvailable = true): MockExamApi {
  const find = (id: string) => exams.find((e) => e.id === id) ?? exams[0] ?? READY;
  const never = () => new Promise<never>(() => undefined);
  return {
    list: () => ok({ llm_available: llmAvailable, items: [...exams] }),
    get: (id) => ok(find(id)),
    create: never,
    regenerate: never,
    rename: (id, title) => ok({ ...find(id), title }),
    remove: () => ok(null),
    questions: () => ok(QUESTIONS),
    editQuestion: never,
    removeQuestion: () => ok(null),
  };
}

const base: Props = {
  open: true,
  onOpenChange: noop,
  container: null,
  workspaceId: WS,
  canEdit: true,
  view: { view: 'list' },
  onViewChange: noop,
  onPractise: noop,
  onBankStarted: noop,
  api: api([]),
};

const meta = {
  title: 'Questions/MockExams',
  component: MockExamsPanel,
  parameters: { layout: 'fullscreen' },
};
export default meta;

const dark = <S extends Story>(story: S): S => ({ ...story, globals: { theme: 'dark' } });

export const Empty: Story = { args: base };
export const EmptyDark = dark(Empty);

export const List: Story = { args: { ...base, api: api([GENERATING, PARTIAL, FAILED, READY]) } };
export const ListDark = dark(List);

export const ViewerList: Story = {
  args: { ...base, canEdit: false, api: api([PARTIAL, READY]) },
};
export const ViewerListDark = dark(ViewerList);

export const Create: Story = { args: { ...base, view: { view: 'create' }, api: api([READY]) } };
export const CreateDark = dark(Create);

export const CreateWithoutAi: Story = {
  args: { ...base, view: { view: 'create' }, api: api([READY], false) },
};
export const CreateWithoutAiDark = dark(CreateWithoutAi);

const detail = (e: MockExam): Story => ({
  args: { ...base, view: { view: 'detail', mockExamId: e.id }, api: api([e]) },
});

export const DetailGenerating = detail(GENERATING);
export const DetailGeneratingDark = dark(DetailGenerating);
export const DetailFailed = detail(FAILED);
export const DetailFailedDark = dark(DetailFailed);
export const DetailPartial = detail(PARTIAL);
export const DetailPartialDark = dark(DetailPartial);
export const DetailReady: Story = {
  args: { ...detail(READY).args, canEdit: false },
};
export const DetailReadyDark = dark(DetailReady);
