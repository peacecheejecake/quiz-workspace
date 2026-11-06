// UX12-HELP `/help`: static usage help, with the release notes as its last section. Rendered inside
// the AppShell, which owns the page's <main>. Release notes list only what has shipped, in words a
// user would recognise: no internal Task IDs.
import { PageHeader, Surface } from '@quiz/ui';
import Link from 'next/link';
import type { ScreenId } from '@/screens';
import styles from './help-screen.module.css';

const GUIDES: readonly { id: string; title: string; items: readonly string[] }[] = [
  {
    id: 'start',
    title: '시작하기',
    items: [
      'Workspace를 만들고 문서 관리에서 PDF를 올리면 본문 검색과 문서 보기를 쓸 수 있습니다.',
      '문제 PDF 가져오기로 문제를 읽어 온 뒤 초안을 확인해 승인하면 문제가 홈에 추가됩니다. 자동으로 읽은 문제는 틀릴 수 있으니 원문과 비교해 주세요.',
      '홈의 칸 하나가 문제 하나입니다. 칸의 모양과 색으로 풀이 상태를 볼 수 있습니다.',
    ],
  },
  {
    id: 'practice',
    title: '문제 풀기',
    items: [
      '칸을 누르면 문제가 열리고, 풀기로 범위를 골라 이어서 풀 수 있습니다.',
      '모의고사는 정해진 범위로 시험지를 만들어 풉니다. 모의고사 기록은 홈의 풀이 상태에 더해지지 않습니다.',
      '정리 노트와 해설에서 글자를 고르면 하이라이트를 남기거나 복사할 수 있습니다.',
      'AI 기능은 서비스에서 켜져 있을 때만 보입니다. AI 답변은 틀릴 수 있으니 원문으로 확인해 주세요.',
    ],
  },
  {
    id: 'settings',
    title: '화면과 설정',
    items: [
      '화면 테마는 오른쪽 위 계정 메뉴에서 시스템·라이트·다크 중에 고릅니다.',
      '드래그 자동 복사는 설정에서 켭니다. 이 브라우저에만 저장되고, 터치 화면에서는 동작하지 않습니다.',
    ],
  },
];

const RELEASES: readonly { title: string; items: readonly string[] }[] = [
  {
    title: '2026년 11월',
    items: [
      '화면 테마를 시스템·라이트·다크 중에 고를 수 있습니다.',
      '글자를 끌어 고르면 바로 복사하는 설정을 추가했습니다.',
      '이 도움말 페이지를 추가했습니다.',
      '홈 상단을 문서 N 메뉴와 풀기로 정리하고, 검색과 필터를 한 줄로 합쳤습니다.',
      '문제 번호를 교재 번호 기준으로 표시하고, 문제와 보기의 표를 열에 맞춰 보여 줍니다.',
      '객관식 결과에 정답·오답 아이콘을 표시하고, 긴 보기의 줄바꿈을 유지합니다.',
      '문제 편집에서 보기를 끌어 순서를 바꿀 수 있습니다.',
      'AI 해설 도구를 한 줄로 정리하고, 만드는 중에 취소할 수 있습니다.',
      'AI 질문 목록과 대화 화면을 다시 구성했습니다.',
      '패널을 끌어서 닫을 수 있고, 손을 떼는 속도에 맞춰 사라집니다.',
      '하이라이트 메뉴를 여는 동안 고른 글자가 유지됩니다.',
      '다른 창에서 돌아올 때 화면이 잠깐 비는 문제를 고쳤습니다.',
    ],
  },
];

export function HelpScreen({ screenId }: { screenId: ScreenId }) {
  return (
    <div className={styles.page} data-screen-id={screenId}>
      <PageHeader title="도움말" description="기본 사용법과 최근 변경 내용을 안내합니다." />

      {GUIDES.map((guide) => (
        <Surface key={guide.id} asChild padding="lg">
          <section aria-labelledby={`help-${guide.id}`} className={styles.section}>
            <h2 id={`help-${guide.id}`} className={styles.title}>
              {guide.title}
            </h2>
            <ul className={styles.list}>
              {guide.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            {guide.id === 'settings' ? (
              <p className={styles.text}>
                <Link href="/settings/preferences">설정 열기</Link>
              </p>
            ) : null}
          </section>
        </Surface>
      ))}

      <Surface asChild padding="lg">
        <section aria-labelledby="help-releases" className={styles.section}>
          <h2 id="help-releases" className={styles.title}>
            릴리스 노트
          </h2>
          {RELEASES.map((release) => (
            <div key={release.title} className={styles.release}>
              <h3 className={styles.releaseTitle}>{release.title}</h3>
              <ul className={styles.list}>
                {release.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </Surface>
    </div>
  );
}
