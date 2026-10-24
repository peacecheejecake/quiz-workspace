// Server Component (no 'use client'): every runtime export of @quiz/ui is imported and every
// component is rendered here with serializable props only. test/client-boundary.test.ts keeps
// this list in sync with src/index.ts.
import {
  AccountIcon,
  AlertIcon,
  ArrowLeftIcon,
  AppShell,
  BackLink,
  Badge,
  Breadcrumb,
  Button,
  CheckIcon,
  Checkbox,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  HistoryIcon,
  SearchIcon,
  ShareIcon,
  TrashIcon,
  CloseIcon,
  ConfirmDialog,
  DialogClose,
  Dropzone,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  FavoriteToggle,
  FloatingSidePanel,
  FocusRing,
  GlassSurface,
  HeatmapLegend,
  IconButton,
  Input,
  MenuIcon,
  MinusIcon,
  MoreIcon,
  ModalDialog,
  PageHeader,
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  QUESTION_DOT_STATUSES,
  QuestionDot,
  QuestionHeatmap,
  QuestionMarker,
  QuestionPreviewPopover,
  RadioGroup,
  RetryIcon,
  RetryToggle,
  Select,
  ProgressBar,
  Skeleton,
  StarIcon,
  StatusSummary,
  Surface,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  UploadIcon,
  ThemeProvider,
  ToastProvider,
  TOOLTIP_DELAY_MS,
  TOOLTIP_DESCRIPTION_DELAY_MS,
  Tooltip,
  deriveDotStatus,
  focusRingClassName,
  questionDotLabel,
  questionStatusLabels,
  questionTypeLabels,
  summarizeStatuses,
  useTheme,
  useToast,
} from '@quiz/ui';

const hooks = [useTheme, useToast];
// Need function props (onOpen / onPressedChange), so a Client Component has to render them.
const interactive = [
  QuestionDot,
  QuestionHeatmap,
  FavoriteToggle,
  RetryToggle,
  ConfirmDialog,
  Dropzone,
];

// The status helpers are plain functions and must be callable on the server.
const questions = QUESTION_DOT_STATUSES.map((status, index) => ({
  status: deriveDotStatus({
    firstViewedAt: status === 'unseen' ? null : '2026-10-01T00:00:00Z',
    lastGradedResult: status === 'correct' || status === 'incorrect' ? status : null,
    needsRetry: status === 'retry',
    isFavorite: index % 2 === 0,
  }),
  isFavorite: index % 2 === 0,
}));
const label = questionDotLabel({
  chapterNumber: 3,
  chapterTitle: '어텐션',
  questionNumber: '12',
  questionType: 'MCQ',
  status: 'retry',
  isFavorite: true,
  lastGradedResult: 'incorrect',
});

export default function Page() {
  return (
    <ThemeProvider defaultTheme="light">
      <ToastProvider>
        <AppShell header={<span>RSC fixture</span>} sidebar={<a href="#main-content">본문</a>}>
          <PageHeader
            title="RSC"
            description={`${hooks.length} hooks exported`}
            back={<BackLink href="/" label="처음으로" />}
            breadcrumb={<Breadcrumb items={[{ label: '홈', href: '/' }, { label: 'RSC' }]} />}
          />
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
            <Switch label="알림" />
            <Select
              label="유형"
              defaultValue="MCQ"
              options={[
                { value: 'MCQ', label: '객관식' },
                { value: 'ESSAY', label: '서술형' },
              ]}
            />
            <RadioGroup
              label="문제 유형"
              defaultValue="MCQ"
              options={[
                { value: 'MCQ', label: '객관식' },
                { value: 'ESSAY', label: '서술형' },
              ]}
            />
            <Skeleton width="4rem" />
            <ProgressBar label="진행률" value={40} />
            <AlertIcon />
            <CheckIcon />
            <ChevronDownIcon />
            <MenuIcon />
            <MinusIcon />
            <MoreIcon />
            <UploadIcon />
            <ArrowLeftIcon />
            <ChevronRightIcon />
            <ChevronUpIcon />
            <SearchIcon />
            <TrashIcon />
            <HistoryIcon />
            <ShareIcon />
            <AccountIcon />
          </Surface>
          <GlassSurface>glass</GlassSurface>
          <Tooltip content="설명" delayDuration={TOOLTIP_DELAY_MS + TOOLTIP_DESCRIPTION_DELAY_MS}>
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
          <Tabs defaultValue="a">
            <TabsList aria-label="탭">
              <TabsTrigger value="a">가</TabsTrigger>
              <TabsTrigger value="b">나</TabsTrigger>
            </TabsList>
            <TabsContent value="a">가 내용</TabsContent>
            <TabsContent value="b">나 내용</TabsContent>
          </Tabs>
          <DropdownMenu>
            <DropdownMenuTrigger>더보기</DropdownMenuTrigger>
            <DropdownMenuContent aria-label="작업">
              <DropdownMenuGroup>
                <DropdownMenuLabel>작업</DropdownMenuLabel>
                <DropdownMenuItem>보관</DropdownMenuItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem tone="danger">삭제</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <p>
            {interactive.length} interactive · {label} · {questionTypeLabels.MCQ}
          </p>
          <StatusSummary counts={summarizeStatuses(questions)} />
          <HeatmapLegend />
          {questions.map(({ status, isFavorite }) => (
            <QuestionMarker key={status} status={status} favorite={isFavorite} />
          ))}
          <QuestionPreviewPopover
            chapterNumber={3}
            chapterTitle="어텐션"
            questionNumber="12"
            questionType="MCQ"
            status="unseen"
            isFavorite={false}
            preview="문제 본문"
          >
            <button type="button">{questionStatusLabels.unseen}</button>
          </QuestionPreviewPopover>
          <StarIcon />
          <RetryIcon />
        </AppShell>
      </ToastProvider>
    </ThemeProvider>
  );
}
