// Deterministic sample data for the questions stories (and the visual regression suite).
import type { HeatmapChapter, HeatmapQuestion } from './QuestionHeatmap';
import { deriveDotStatus, type QuestionType } from './status';

/** Small LCG so the stories render the same heatmap on every build. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const TITLES = [
  'Fundamentals',
  'Attention',
  'Transformers',
  'Pretraining',
  'Fine-tuning',
  'Retrieval',
  'Evaluation',
  'Deployment',
];
const TYPES: QuestionType[] = ['MCQ', 'MCQ', 'MCQ', 'SHORT_ANSWER', 'ESSAY'];
const STEMS = [
  'Scaled dot-product attention에서 키 차원의 제곱근으로 나누는 이유를 고르시오.',
  '다음 중 layer normalization의 위치에 따른 학습 안정성 차이를 옳게 설명한 것은?',
  'BPE 토크나이저가 희귀 단어를 처리하는 방식을 서술하시오. 예시를 하나 이상 포함한다.',
  '검색 증강 생성에서 reranker를 사용할 때의 장점과 비용을 비교하시오.',
];

/** `sizes[i]` questions in chapter i+1 (default 8 chapters, 200 questions). */
export function sampleChapters(
  sizes: number[] = [32, 28, 24, 30, 22, 26, 20, 18],
  seed = 7,
): HeatmapChapter[] {
  const next = random(seed);
  return sizes.map((size, c) => ({
    id: `chapter-${c + 1}`,
    number: c + 1,
    title: `${c + 1}장 ${TITLES[c % TITLES.length] ?? ''}`,
    questions: Array.from({ length: size }, (_, i): HeatmapQuestion => {
      const viewed = next() < 0.6;
      const graded = viewed && next() < 0.6;
      const lastGradedResult = graded ? (next() < 0.65 ? 'correct' : 'incorrect') : null;
      const needsRetry = next() < 0.08;
      const isFavorite = next() < 0.12;
      const type = TYPES[Math.floor(next() * TYPES.length)] ?? 'MCQ';
      return {
        id: `q-${c + 1}-${i + 1}`,
        number: String(i + 1),
        type,
        status: deriveDotStatus({
          firstViewedAt: viewed ? '2026-10-01T09:00:00Z' : null,
          lastGradedResult,
          needsRetry,
          isFavorite,
        }),
        isFavorite,
        lastGradedResult,
        needsRetry,
        isPendingGrading: type === 'ESSAY' && viewed && !graded && next() < 0.5,
        preview: STEMS[(c + i) % STEMS.length] ?? '',
      };
    }),
  }));
}
