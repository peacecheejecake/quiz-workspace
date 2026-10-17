import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  AppShell,
  Badge,
  Button,
  Checkbox,
  CloseIcon,
  EmptyState,
  FloatingSidePanel,
  FocusRing,
  GlassSurface,
  IconButton,
  Input,
  ModalDialog,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Surface,
  Textarea,
  ThemeProvider,
  ToastProvider,
  Tooltip,
} from '../src';
import { axeViolations } from './axe';

const cases: [name: string, element: () => ReactElement][] = [
  ['Button', () => <Button>저장</Button>],
  [
    'Button (primary, loading, disabled)',
    () => (
      <>
        <Button variant="primary">시작</Button>
        <Button loading>저장 중</Button>
        <Button disabled>비활성</Button>
      </>
    ),
  ],
  ['IconButton', () => <IconButton label="닫기" icon={<CloseIcon />} />],
  ['Input', () => <Input label="이메일" description="로그인에 사용합니다." />],
  ['Input (error)', () => <Input label="이메일" error="이메일 형식이 올바르지 않습니다." />],
  ['Textarea', () => <Textarea label="메모" />],
  ['Checkbox', () => <Checkbox label="기억하기" description="이 기기에서 로그인 유지" />],
  [
    'Badge',
    () => (
      <>
        <Badge>기본</Badge>
        <Badge tone="danger">오류</Badge>
      </>
    ),
  ],
  ['Surface', () => <Surface>카드 내용</Surface>],
  ['GlassSurface', () => <GlassSurface>떠 있는 표면</GlassSurface>],
  [
    'FocusRing',
    () => (
      <FocusRing>
        <a href="#x">링크</a>
      </FocusRing>
    ),
  ],
  [
    'Tooltip (open)',
    () => (
      <Tooltip content="설정 열기" open>
        <Button>설정</Button>
      </Tooltip>
    ),
  ],
  [
    'Popover (open)',
    () => (
      <Popover defaultOpen>
        <PopoverTrigger asChild>
          <Button>미리보기</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="문제 미리보기" closeLabel="닫기">
          미리보기 내용
        </PopoverContent>
      </Popover>
    ),
  ],
  ['ToastProvider', () => <ToastProvider>앱</ToastProvider>],
  ['Skeleton', () => <Skeleton width="12rem" />],
  [
    'ModalDialog (open)',
    () => (
      <ModalDialog defaultOpen title="Workspace 삭제" description="되돌릴 수 없습니다.">
        본문
      </ModalDialog>
    ),
  ],
  [
    'FloatingSidePanel modal (open)',
    () => (
      <FloatingSidePanel defaultOpen title="문제 3" footer={<Button>제출</Button>}>
        문제 본문
      </FloatingSidePanel>
    ),
  ],
  [
    'FloatingSidePanel non-modal (open)',
    () => (
      <>
        <main>
          <button type="button">배경</button>
        </main>
        <FloatingSidePanel defaultOpen modal={false} title="발췌" description="3쪽">
          발췌 본문
        </FloatingSidePanel>
      </>
    ),
  ],
  [
    'AppShell',
    () => (
      <AppShell header={<span>Quiz Workspace</span>} sidebar={<a href="#docs">문서</a>}>
        <PageHeader title="문서" description="업로드한 책" actions={<Button>업로드</Button>} />
        <EmptyState
          title="아직 문서가 없습니다"
          description="PDF를 업로드해 시작하세요."
          action={<Button variant="primary">업로드</Button>}
        />
      </AppShell>
    ),
  ],
];

describe.each(['light', 'dark'] as const)('axe (%s theme)', (theme) => {
  it.each(cases)('%s has no violations', async (_name, element) => {
    render(<ThemeProvider theme={theme}>{element()}</ThemeProvider>);
    expect(document.documentElement).toHaveAttribute('data-theme', theme);
    expect(await axeViolations()).toEqual([]);
  });
});

describe('Tooltip', () => {
  it('describes its trigger when open', async () => {
    render(
      <Tooltip content="설정 열기" open>
        <Button>설정</Button>
      </Tooltip>,
    );
    expect(await screen.findByRole('tooltip')).toHaveTextContent('설정 열기');
  });
});
