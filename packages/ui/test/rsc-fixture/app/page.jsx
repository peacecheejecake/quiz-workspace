// Server Component (no 'use client'): every runtime export of @quiz/ui is imported and every
// component is rendered here with serializable props only. test/client-boundary.test.ts keeps
// this list in sync with src/index.ts.
import {
  AlertIcon,
  AppShell,
  Badge,
  Button,
  CheckIcon,
  Checkbox,
  CloseIcon,
  DialogClose,
  EmptyState,
  FloatingSidePanel,
  FocusRing,
  GlassSurface,
  IconButton,
  Input,
  MenuIcon,
  MinusIcon,
  ModalDialog,
  PageHeader,
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Surface,
  Textarea,
  ThemeProvider,
  ToastProvider,
  Tooltip,
  focusRingClassName,
  useTheme,
  useToast,
} from '@quiz/ui';

const hooks = [useTheme, useToast];

export default function Page() {
  return (
    <ThemeProvider defaultTheme="light">
      <ToastProvider>
        <AppShell header={<span>RSC fixture</span>} sidebar={<a href="#main-content">본문</a>}>
          <PageHeader title="RSC" description={`${hooks.length} hooks exported`} />
          <Surface>
            <Badge tone="success">ok</Badge>
            <Button variant="primary">버튼</Button>
            <IconButton label="닫기" icon={<CloseIcon />} />
            <FocusRing>
              <a href="#x" className={focusRingClassName}>
                링크
              </a>
            </FocusRing>
            <Input label="이메일" error="오류" />
            <Textarea label="메모" />
            <Checkbox label="동의" />
            <Skeleton width="4rem" />
            <AlertIcon />
            <CheckIcon />
            <MenuIcon />
            <MinusIcon />
          </Surface>
          <GlassSurface>glass</GlassSurface>
          <Tooltip content="설명">
            <Button>툴팁</Button>
          </Tooltip>
          <Popover>
            <PopoverAnchor />
            <PopoverTrigger>미리보기</PopoverTrigger>
            <PopoverContent aria-label="미리보기" closeLabel="닫기">
              <PopoverClose>닫기</PopoverClose>
            </PopoverContent>
          </Popover>
          <ModalDialog title="대화상자" trigger={<Button>열기</Button>}>
            <DialogClose>닫기</DialogClose>
          </ModalDialog>
          <FloatingSidePanel title="패널" modal={false} trigger={<Button>패널</Button>}>
            본문
          </FloatingSidePanel>
          <EmptyState title="비어 있음" />
        </AppShell>
      </ToastProvider>
    </ThemeProvider>
  );
}
