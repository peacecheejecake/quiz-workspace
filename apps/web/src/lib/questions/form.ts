// QBANK-01 question editor model. Pure: the form state, its validation (mirroring the API's
// quiz_api.question_rules so most mistakes are caught before a request) and the request bodies.
//
// Option ids are opaque, client-chosen and stable (docs/questions.md §4.3, fixtures A2): a new
// option gets `opt-<random>` once and keeps it through text edits, reordering and saves, so
// grading by option id stays valid across revisions.
import type { Schemas } from '@quiz/api-client';

export type Question = Schemas['Question'];
export type QuestionDetail = Schemas['QuestionDetail'];
export type QuestionType = Question['question_type'];
export type PublicationStatus = Question['publication_status'];
export type QuestionCreateBody = Schemas['QuestionCreate'];
export type QuestionUpdateBody = Schemas['QuestionUpdate'];

export const QUESTION_TYPES: readonly QuestionType[] = ['MCQ', 'SHORT_ANSWER', 'ESSAY'];

export const QUESTION_TYPE_LABELS: Readonly<Record<QuestionType, string>> = {
  MCQ: '객관식',
  SHORT_ANSWER: '단답형',
  ESSAY: '서술형',
};

export const PUBLICATION_STATUS_LABELS: Readonly<Record<PublicationStatus, string>> = {
  DRAFT: '초안',
  CONFIRMED: '확정',
  ARCHIVED: '보관됨',
};

// Limits of quiz_api.question_rules.
export const LIMITS = {
  stem: 20000,
  longText: 20000,
  options: 50,
  optionText: 5000,
  acceptedAnswers: 50,
  acceptedAnswer: 1000,
  sources: 20,
  minConfirmedOptions: 2,
  maxInt: 2147483647,
} as const;

export const DEFAULT_OPTION_COUNT = 4;

export interface OptionDraft {
  /** Stable option id (`opt-<random>` for new options, the server's id for existing ones). */
  readonly id: string;
  readonly text: string;
  readonly correct: boolean;
}

export interface SourceDraft {
  /** Local row key (never sent). */
  readonly key: string;
  readonly documentId: string;
  readonly pageStart: string;
  readonly pageEnd: string;
}

export interface QuestionFormValues {
  readonly type: QuestionType;
  readonly stem: string;
  readonly options: readonly OptionDraft[];
  readonly multiAnswer: boolean;
  /** One accepted answer per line (SHORT_ANSWER); empty = not auto-gradable. */
  readonly acceptedAnswers: string;
  readonly explanation: string;
  readonly rubric: string;
  /** Outline node id, or '' for none. */
  readonly chapterId: string;
  readonly questionNumber: string;
  readonly sources: readonly SourceDraft[];
}

/** Field keys of form errors. Options use `option:<id>`, sources `source:<key>`. */
export type FieldErrors = Readonly<Record<string, string>>;

export const FORM_KEY = 'form';
export const optionKey = (id: string): string => `option:${id}`;
export const sourceKey = (key: string): string => `source:${key}`;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A new opaque option id: `opt-` + 12 random base-36 characters (no whitespace, URL-safe). */
export function newOptionId(random: (bytes: Uint8Array) => Uint8Array = defaultRandom): string {
  const bytes = random(new Uint8Array(12));
  let suffix = '';
  for (const byte of bytes) suffix += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `opt-${suffix}`;
}

function defaultRandom(bytes: Uint8Array): Uint8Array {
  return crypto.getRandomValues(bytes);
}

let sourceSeq = 0;
function newSourceKey(): string {
  sourceSeq += 1;
  return `src-${sourceSeq}`;
}

export function emptyOption(mintId: () => string = newOptionId): OptionDraft {
  return { id: mintId(), text: '', correct: false };
}

export function emptyForm(mintId: () => string = newOptionId): QuestionFormValues {
  return {
    type: 'MCQ',
    stem: '',
    options: Array.from({ length: DEFAULT_OPTION_COUNT }, () => emptyOption(mintId)),
    multiAnswer: false,
    acceptedAnswers: '',
    explanation: '',
    rubric: '',
    chapterId: '',
    questionNumber: '',
    sources: [],
  };
}

/** Form values of an existing question (its active revision). Option ids are kept verbatim. */
export function formFromQuestion(question: Question): QuestionFormValues {
  const rev = question.revision;
  const correct = new Set(rev.correct_option_ids ?? []);
  return {
    type: question.question_type,
    stem: rev.stem,
    options: rev.options.map((o) => ({ id: o.id, text: o.text, correct: correct.has(o.id) })),
    multiAnswer: rev.is_multi_answer,
    acceptedAnswers: (rev.accepted_answers ?? []).join('\n'),
    explanation: rev.explanation ?? '',
    rubric: rev.rubric ?? '',
    chapterId: question.chapter_id ?? '',
    questionNumber: question.question_number == null ? '' : String(question.question_number),
    sources: question.sources
      .filter((s): s is typeof s & { document_id: string } => s.document_id != null)
      .map((s) => ({
        key: newSourceKey(),
        documentId: s.document_id,
        pageStart: s.page_start == null ? '' : String(s.page_start),
        pageEnd: s.page_end == null || s.page_end === s.page_start ? '' : String(s.page_end),
      })),
  };
}

// ---------------------------------------------------------------------------------------------
// Updates (immutable)
// ---------------------------------------------------------------------------------------------

export function setOptionText(
  values: QuestionFormValues,
  id: string,
  text: string,
): QuestionFormValues {
  return { ...values, options: values.options.map((o) => (o.id === id ? { ...o, text } : o)) };
}

/** Marks `id` correct or not. A single-answer question keeps at most one correct option. */
export function setOptionCorrect(
  values: QuestionFormValues,
  id: string,
  correct: boolean,
): QuestionFormValues {
  return {
    ...values,
    options: values.options.map((o) => {
      if (o.id === id) return { ...o, correct };
      return correct && !values.multiAnswer && o.correct ? { ...o, correct: false } : o;
    }),
  };
}

/** Switching to single answer keeps only the first correct option. */
export function setMultiAnswer(values: QuestionFormValues, multi: boolean): QuestionFormValues {
  if (multi) return { ...values, multiAnswer: true };
  let kept = false;
  return {
    ...values,
    multiAnswer: false,
    options: values.options.map((o) => {
      if (!o.correct) return o;
      if (kept) return { ...o, correct: false };
      kept = true;
      return o;
    }),
  };
}

export function addOption(
  values: QuestionFormValues,
  mintId: () => string = newOptionId,
): QuestionFormValues {
  const taken = new Set(values.options.map((o) => o.id));
  let id = mintId();
  while (taken.has(id)) id = mintId();
  return { ...values, options: [...values.options, { id, text: '', correct: false }] };
}

export function removeOption(values: QuestionFormValues, id: string): QuestionFormValues {
  return { ...values, options: values.options.filter((o) => o.id !== id) };
}

/** Moves an option up (-1) or down (+1); ids travel with their text. */
export function moveOption(
  values: QuestionFormValues,
  id: string,
  delta: -1 | 1,
): QuestionFormValues {
  const from = values.options.findIndex((o) => o.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= values.options.length) return values;
  const options = [...values.options];
  const [moved] = options.splice(from, 1);
  if (moved) options.splice(to, 0, moved);
  return { ...values, options };
}

export function addSource(values: QuestionFormValues, documentId: string): QuestionFormValues {
  return {
    ...values,
    sources: [...values.sources, { key: newSourceKey(), documentId, pageStart: '', pageEnd: '' }],
  };
}

export function updateSource(
  values: QuestionFormValues,
  key: string,
  patch: Partial<Omit<SourceDraft, 'key'>>,
): QuestionFormValues {
  return {
    ...values,
    sources: values.sources.map((s) => (s.key === key ? { ...s, ...patch } : s)),
  };
}

export function removeSource(values: QuestionFormValues, key: string): QuestionFormValues {
  return { ...values, sources: values.sources.filter((s) => s.key !== key) };
}

// ---------------------------------------------------------------------------------------------
// Validation (mirrors quiz_api.question_rules; the API stays the authority)
// ---------------------------------------------------------------------------------------------

export const MESSAGES = {
  stemRequired: '문제 내용을 입력해 주세요.',
  stemTooLong: `문제 내용은 ${LIMITS.stem.toLocaleString('ko-KR')}자 이하로 입력해 주세요.`,
  optionRequired: (n: number) => `보기 ${n}의 내용을 입력하거나 보기를 삭제해 주세요.`,
  optionTooLong: (n: number) =>
    `보기 ${n}은 ${LIMITS.optionText.toLocaleString('ko-KR')}자 이하로 입력해 주세요.`,
  tooFewOptions: `객관식 문제에는 보기가 ${LIMITS.minConfirmedOptions}개 이상 필요합니다.`,
  tooManyOptions: `보기는 ${LIMITS.options}개까지 등록할 수 있습니다.`,
  correctRequired: '정답 보기를 선택해 주세요.',
  singleAnswer: '단일 정답 문제는 정답 보기를 하나만 선택할 수 있습니다.',
  acceptedTooMany: `허용 답안은 ${LIMITS.acceptedAnswers}개까지 등록할 수 있습니다.`,
  acceptedTooLong: `허용 답안은 한 줄에 ${LIMITS.acceptedAnswer.toLocaleString('ko-KR')}자 이하로 입력해 주세요.`,
  longTextTooLong: `${LIMITS.longText.toLocaleString('ko-KR')}자 이하로 입력해 주세요.`,
  controlChars: '입력할 수 없는 문자가 포함되어 있습니다.',
  questionNumber: '문제 번호는 1 이상의 정수로 입력해 주세요.',
  sourceDocument: '출처 문서를 선택해 주세요.',
  sourcePages: '쪽 번호는 1 이상의 정수이며 끝 쪽은 시작 쪽보다 앞설 수 없습니다.',
  tooManySources: `출처는 ${LIMITS.sources}개까지 연결할 수 있습니다.`,
} as const;

/** Characters PostgreSQL text cannot store (NUL, lone surrogates). */
function unstorable(value: string): boolean {
  if (value.includes('\u0000')) return true;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/** Length in code points, like Python's `len`. */
function length(value: string): number {
  let n = 0;
  for (const _ of value) n += 1;
  return n;
}

export function acceptedAnswerList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function positiveInt(raw: string): number | null | 'invalid' {
  const text = raw.trim();
  if (text === '') return null;
  if (!/^\d+$/.test(text)) return 'invalid';
  const n = Number(text);
  return n >= 1 && n <= LIMITS.maxInt ? n : 'invalid';
}

/** Every rule violation of `values` (empty = valid for a CONFIRMED question). */
export function validateQuestionForm(values: QuestionFormValues): FieldErrors {
  const errors: Record<string, string> = {};
  const longText = (key: string, value: string) => {
    if (unstorable(value)) errors[key] = MESSAGES.controlChars;
    else if (length(value) > LIMITS.longText) errors[key] = MESSAGES.longTextTooLong;
  };

  if (values.stem.trim() === '') errors.stem = MESSAGES.stemRequired;
  else if (unstorable(values.stem)) errors.stem = MESSAGES.controlChars;
  else if (length(values.stem) > LIMITS.stem) errors.stem = MESSAGES.stemTooLong;
  longText('explanation', values.explanation);

  if (values.type === 'MCQ') {
    values.options.forEach((o, i) => {
      if (o.text.trim() === '') errors[optionKey(o.id)] = MESSAGES.optionRequired(i + 1);
      else if (unstorable(o.text)) errors[optionKey(o.id)] = MESSAGES.controlChars;
      else if (length(o.text) > LIMITS.optionText) {
        errors[optionKey(o.id)] = MESSAGES.optionTooLong(i + 1);
      }
    });
    if (values.options.length < LIMITS.minConfirmedOptions) errors.options = MESSAGES.tooFewOptions;
    else if (values.options.length > LIMITS.options) errors.options = MESSAGES.tooManyOptions;
    const correct = values.options.filter((o) => o.correct).length;
    if (correct === 0) errors.correct = MESSAGES.correctRequired;
    else if (!values.multiAnswer && correct > 1) errors.correct = MESSAGES.singleAnswer;
  } else if (values.type === 'SHORT_ANSWER') {
    const answers = acceptedAnswerList(values.acceptedAnswers);
    if (answers.length > LIMITS.acceptedAnswers) errors.acceptedAnswers = MESSAGES.acceptedTooMany;
    else if (answers.some(unstorable)) errors.acceptedAnswers = MESSAGES.controlChars;
    else if (answers.some((a) => length(a) > LIMITS.acceptedAnswer)) {
      errors.acceptedAnswers = MESSAGES.acceptedTooLong;
    }
  } else {
    longText('rubric', values.rubric);
  }

  if (positiveInt(values.questionNumber) === 'invalid') {
    errors.questionNumber = MESSAGES.questionNumber;
  }
  if (values.sources.length > LIMITS.sources) errors.sources = MESSAGES.tooManySources;
  for (const s of values.sources) {
    const start = positiveInt(s.pageStart);
    const end = positiveInt(s.pageEnd);
    if (!s.documentId) errors[sourceKey(s.key)] = MESSAGES.sourceDocument;
    else if (
      start === 'invalid' ||
      end === 'invalid' ||
      (end !== null && start === null) ||
      (start !== null && end !== null && end < start)
    ) {
      errors[sourceKey(s.key)] = MESSAGES.sourcePages;
    }
  }
  return errors;
}

/**
 * Re-reads form values received from the client (server actions take untrusted input): only the
 * known fields, with the right primitive types, survive. `null` = not a form at all.
 */
export function parseFormValues(raw: unknown): QuestionFormValues | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
  const type = str(v.type);
  if (!type || !(QUESTION_TYPES as readonly string[]).includes(type)) return null;
  if (!Array.isArray(v.options) || !Array.isArray(v.sources)) return null;
  const options: OptionDraft[] = [];
  for (const o of v.options as unknown[]) {
    if (typeof o !== 'object' || o === null) return null;
    const { id, text, correct } = o as Record<string, unknown>;
    if (typeof id !== 'string' || typeof text !== 'string' || typeof correct !== 'boolean') {
      return null;
    }
    options.push({ id, text, correct });
  }
  const sources: SourceDraft[] = [];
  for (const s of v.sources as unknown[]) {
    if (typeof s !== 'object' || s === null) return null;
    const { key, documentId, pageStart, pageEnd } = s as Record<string, unknown>;
    if (
      typeof key !== 'string' ||
      typeof documentId !== 'string' ||
      typeof pageStart !== 'string' ||
      typeof pageEnd !== 'string'
    ) {
      return null;
    }
    sources.push({ key, documentId, pageStart, pageEnd });
  }
  const fields = [
    'stem',
    'acceptedAnswers',
    'explanation',
    'rubric',
    'chapterId',
    'questionNumber',
  ];
  if (fields.some((f) => typeof v[f] !== 'string') || typeof v.multiAnswer !== 'boolean') {
    return null;
  }
  return {
    type: type as QuestionType,
    stem: v.stem as string,
    options,
    multiAnswer: v.multiAnswer,
    acceptedAnswers: v.acceptedAnswers as string,
    explanation: v.explanation as string,
    rubric: v.rubric as string,
    chapterId: v.chapterId as string,
    questionNumber: v.questionNumber as string,
    sources,
  };
}

// ---------------------------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------------------------

type Content = Required<
  Pick<
    QuestionCreateBody,
    | 'stem'
    | 'options'
    | 'correct_option_ids'
    | 'is_multi_answer'
    | 'accepted_answers'
    | 'explanation'
    | 'rubric'
  >
>;

function nullIfBlank(value: string): string | null {
  return value.trim() === '' ? null : value;
}

/** The revisioned content of `values`, shaped for the question's type. */
export function contentBody(values: QuestionFormValues): Content {
  const isMcq = values.type === 'MCQ';
  const answers = acceptedAnswerList(values.acceptedAnswers);
  return {
    stem: values.stem,
    options: isMcq ? values.options.map((o) => ({ id: o.id, text: o.text })) : [],
    correct_option_ids: isMcq ? values.options.filter((o) => o.correct).map((o) => o.id) : null,
    is_multi_answer: isMcq && values.multiAnswer,
    accepted_answers: values.type === 'SHORT_ANSWER' && answers.length > 0 ? answers : null,
    explanation: nullIfBlank(values.explanation),
    rubric: values.type === 'ESSAY' ? nullIfBlank(values.rubric) : null,
  };
}

function sourcesBody(values: QuestionFormValues): NonNullable<QuestionCreateBody['sources']> {
  return values.sources.map((s) => {
    const start = positiveInt(s.pageStart);
    const end = positiveInt(s.pageEnd);
    return {
      document_id: s.documentId,
      page_start: typeof start === 'number' ? start : null,
      page_end: typeof end === 'number' ? end : typeof start === 'number' ? start : null,
    };
  });
}

function questionNumber(values: QuestionFormValues): number | null {
  const n = positiveInt(values.questionNumber);
  return typeof n === 'number' ? n : null;
}

export function createBody(values: QuestionFormValues): QuestionCreateBody {
  return {
    question_type: values.type,
    publication_status: 'CONFIRMED',
    ...contentBody(values),
    chapter_id: values.chapterId || null,
    question_number: questionNumber(values),
    sources: sourcesBody(values),
  };
}

/** A full edit of content + metadata on top of `baseRevisionId` (the type never changes). */
export function updateBody(values: QuestionFormValues, baseRevisionId: string): QuestionUpdateBody {
  return {
    base_revision_id: baseRevisionId,
    ...contentBody(values),
    chapter_id: values.chapterId || null,
    question_number: questionNumber(values),
    sources: sourcesBody(values),
  };
}

// ---------------------------------------------------------------------------------------------
// API 422 → form fields
// ---------------------------------------------------------------------------------------------

export interface ValidationIssue {
  readonly loc: readonly (string | number)[];
  readonly msg: string;
  readonly type?: string;
}

const FIELD_MESSAGES: Readonly<Record<string, string>> = {
  stem: '문제 내용을 확인해 주세요.',
  options: '보기를 확인해 주세요.',
  correct: '정답 보기를 확인해 주세요.',
  acceptedAnswers: '허용 답안을 확인해 주세요.',
  explanation: '해설을 확인해 주세요.',
  rubric: '채점 기준을 확인해 주세요.',
  chapterId: '선택한 챕터를 사용할 수 없습니다. 문서의 현재 목차에서 다시 선택해 주세요.',
  questionNumber: MESSAGES.questionNumber,
  sources: '출처를 확인해 주세요.',
  [FORM_KEY]: '입력한 내용을 확인해 주세요.',
};

/**
 * Maps the API's 422 `errors[]` (FastAPI-style `loc` paths into the request body) onto form field
 * keys. `options` / `sources` are the arrays that were sent, so an index resolves to the option id
 * or source row it named. Messages are Korean (the API's are English and stay out of the UI).
 */
export function fieldErrorsFromIssues(
  issues: readonly ValidationIssue[],
  sent: { readonly options: readonly OptionDraft[]; readonly sources: readonly SourceDraft[] },
): FieldErrors {
  const errors: Record<string, string> = {};
  const put = (key: string, message?: string) => {
    errors[key] ??= message ?? FIELD_MESSAGES[key] ?? FIELD_MESSAGES[FORM_KEY] ?? '';
  };
  for (const issue of issues) {
    const loc = issue.loc[0] === 'body' ? issue.loc.slice(1) : issue.loc;
    const [field, index] = loc;
    switch (field) {
      case 'stem':
      case 'explanation':
      case 'rubric':
        put(field);
        break;
      case 'options': {
        const option = typeof index === 'number' ? sent.options[index] : undefined;
        if (option) {
          put(optionKey(option.id), MESSAGES.optionRequired(Number(index) + 1));
        } else put('options');
        break;
      }
      case 'correct_option_ids':
      case 'is_multi_answer':
        put('correct');
        break;
      case 'accepted_answers':
        put('acceptedAnswers');
        break;
      case 'chapter_id':
        put('chapterId');
        break;
      case 'question_number':
        put('questionNumber');
        break;
      case 'sources': {
        const source = typeof index === 'number' ? sent.sources[index] : undefined;
        if (source) put(sourceKey(source.key), FIELD_MESSAGES.sources);
        else put('sources');
        break;
      }
      default:
        put(FORM_KEY);
    }
  }
  return errors;
}

/** Field errors in display order (for the form-level alert). */
export function errorSummary(errors: FieldErrors, values: QuestionFormValues): string[] {
  const order = [
    FORM_KEY,
    'stem',
    'options',
    ...values.options.map((o) => optionKey(o.id)),
    'correct',
    'acceptedAnswers',
    'rubric',
    'explanation',
    'chapterId',
    'questionNumber',
    'sources',
    ...values.sources.map((s) => sourceKey(s.key)),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of [...order, ...Object.keys(errors)]) {
    const message = errors[key];
    if (message && !seen.has(key)) {
      seen.add(key);
      out.push(message);
    }
  }
  return out;
}
