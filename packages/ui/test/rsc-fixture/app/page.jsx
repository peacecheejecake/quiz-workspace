// Server Component (no 'use client'): every runtime export of @quiz/ui is imported and every
// component is rendered here with serializable props only. test/client-boundary.test.ts keeps
// this list in sync with src/index.ts.
import {
  useModalLayerOpen,
  useDragDismiss,
  AccountIcon,
  AlertIcon,
  ArrowLeftIcon,
  AppShell,
  BackLink,
  Badge,
  Breadcrumb,
  Button,
  ChapterPicker,
  CheckIcon,
  Checkbox,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FilterIcon,
  PlusIcon,
  ChevronUpIcon,
  HistoryIcon,
  SearchIcon,
  ShareIcon,
  SplitView,
  TrashIcon,
  CloseIcon,
  GripIcon,
  ConfirmDialog,
  COPY_FEEDBACK_MS,
  CopyButton,
  CopyIcon,
  DialogClose,
  Dropzone,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
  ownEscapeProps,
  PageHeader,
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  NO_QUESTION_NUMBER,
  QUESTION_DOT_STATUSES,
  QuestionDot,
  focusQuestionDotQuietly,
  QuestionHeatmap,
  QuestionMarker,
  QuestionPreviewPopover,
  RadioGroup,
  RetryIcon,
  RetryToggle,
  Select,
  ProgressBar,
  StepProgress,
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
  questionNumberLabel,
  questionStatusLabels,
  questionTitle,
  questionTypeLabels,
  summarizeStatuses,
  useTheme,
  useToast,
  useUnsavedChanges,
  colorAction,
  drawableHighlights,
  exactHighlight,
  FIND_IN_NOTE_LIMIT,
  copyableText,
  findInNote,
  foldForSearch,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_MENU_TEXT,
  highlightColorLabels,
  HighlightableText,
  HighlightMenu,
  matchCountLabel,
  overlappingHighlights,
  POINTER_FLOATING_CLOSE_MS,
  PointerAnchoredFloating,
  PREVIEW_CLOSE_MS,
  PREVIEW_LONG_PRESS_MS,
  PreviewTooltip,
  usePairedSheet,
  SEARCH_DEBOUNCE_MS,
  SEARCH_FIELD_TEXT,
  SearchField,
  SearchMatchText,
  TOUCH_SELECTION_REST_MS,
} from '@quiz/ui';

// Constants must be real numbers on the server, not client references (a client module's export).
for (const value of [PREVIEW_CLOSE_MS, PREVIEW_LONG_PRESS_MS, TOOLTIP_DELAY_MS]) {
  if (typeof value !== 'number') throw new Error('kit constants must be plain numbers in RSC');
}

if (typeof copyableText !== 'function') throw new Error('copyableText must be a plain function');

const hooks = [useTheme, useToast, useUnsavedChanges, usePairedSheet, useDragDismiss];
// Need function props (onOpen / onPressedChange), so a Client Component has to render them.
const interactive = [
  QuestionDot,
  QuestionHeatmap,
  FavoriteToggle,
  RetryToggle,
  ConfirmDialog,
  Dropzone,
  CopyButton,
  HighlightMenu,
  SearchField,
];
const copyFeedbackMs = COPY_FEEDBACK_MS;

// The reading helpers are plain functions and must be callable on the server too.
const noteBlocks = [
  { id: 's0.i0', text: '증발과 응축의 순서를 묻는다.' },
  { id: 's0.i1', text: '주의: ＡＴＴＥＮＴＩＯＮ과 attention.' },
];
const noteHighlights = [{ id: 'h1', block: 's0.i0', start: 0, end: 2, color: HIGHLIGHT_COLORS[0] }];
const found = findInNote(noteBlocks, foldForSearch('ATTENTION'), FIND_IN_NOTE_LIMIT);
const readingSummary = [
  matchCountLabel(found.matches.length, found.capped),
  drawableHighlights(noteHighlights, noteBlocks[0]).length,
  exactHighlight(noteHighlights, { block: 's0.i0', start: 0, end: 2 })?.id,
  overlappingHighlights(noteHighlights, { block: 's0.i0', start: 1, end: 4 }).length,
  colorAction(noteHighlights, { block: 's0.i0', start: 1, end: 4 }, 'blue')?.type,
  highlightColorLabels.pink,
  HIGHLIGHT_MENU_TEXT.label,
  SEARCH_FIELD_TEXT.none,
  SEARCH_DEBOUNCE_MS +
    TOUCH_SELECTION_REST_MS +
    POINTER_FLOATING_CLOSE_MS +
    PREVIEW_CLOSE_MS +
    PREVIEW_LONG_PRESS_MS,
].join(' · ');

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
const numberLabels = [questionNumberLabel(12), questionTitle(null), NO_QUESTION_NUMBER].join(' · ');

export default function Page() {
  void useModalLayerOpen;
  void useDragDismiss;
  void focusQuestionDotQuietly;
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
            <GripIcon />
            <FocusRing>
              <a href="#x" className={focusRingClassName}>
                링크
              </a>
            </FocusRing>
            <Input label="이메일" error="오류" />
            <Textarea label="메모" />
            <Checkbox label="동의" />
            <Switch label="알림" />
            <ChapterPicker
              label="챕터"
              nodes={[{ value: 'a', label: '1장', level: 1 }]}
              value="a"
            />
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
            <StepProgress
              label="가져오기 진행률"
              steps={[
                { id: 'a', label: '업로드' },
                { id: 'b', label: '분석' },
              ]}
              current={1}
              value={30}
            />
            <AlertIcon />
            <CheckIcon />
            <CopyIcon data-ms={copyFeedbackMs} />
            <ChevronDownIcon />
            <ChevronLeftIcon />
            <FilterIcon />
            <PlusIcon />
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
            <div {...ownEscapeProps}>본문</div>
          </FloatingSidePanel>
          <div style={{ height: '200px' }}>
            <SplitView separatorLabel="크기 조절" orientation="vertical" visible="both">
              <p>앞</p>
              <p>뒤</p>
            </SplitView>
          </div>
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
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>색 바꾸기</DropdownMenuSubTrigger>
                <DropdownMenuSubContent aria-label="색 바꾸기">
                  <DropdownMenuRadioGroup value="yellow">
                    <DropdownMenuRadioItem value="yellow">노랑</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
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
          <p>{readingSummary}</p>
          <p>{numberLabels}</p>
          <HighlightableText
            label="정리 노트 본문"
            blocks={noteBlocks.map((b, i) => ({ ...b, suffix: <a href="#fn">[{i + 1}]</a> }))}
            highlights={noteHighlights}
            matches={found.matches.map((m, i) => ({ ...m, current: i === 0 }))}
          />
          <SearchMatchText text="주의 주의" matches={[{ start: 0, end: 2, current: true }]} />
          <PointerAnchoredFloating label="문제 미리보기" content="3장 12번 · 객관식">
            <a href="#q">[1]</a>
          </PointerAnchoredFloating>
          <PreviewTooltip content="원문">
            <button type="button">문제 원문 보기</button>
          </PreviewTooltip>
          <FloatingSidePanel paired title="문제 원문" trigger={<Button>짝 dialog</Button>}>
            원문
          </FloatingSidePanel>
        </AppShell>
      </ToastProvider>
    </ThemeProvider>
  );
}
