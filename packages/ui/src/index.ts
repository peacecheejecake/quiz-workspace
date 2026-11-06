// Public API of @quiz/ui. Styles ship separately: import '@quiz/ui/styles.css' once at the root.
export { ThemeProvider, useTheme } from './theme/ThemeProvider';
export type { ThemeContextValue, ThemePreference, ThemeProviderProps } from './theme/ThemeProvider';

export { Badge } from './primitives/Badge';
export type { BadgeProps, BadgeTone } from './primitives/Badge';
export { Button } from './primitives/Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './primitives/Button';
export { Checkbox } from './primitives/Checkbox';
export type { CheckboxProps } from './primitives/Checkbox';
export {
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
} from './primitives/DropdownMenu';
export type {
  DropdownMenuContentProps,
  DropdownMenuGroupProps,
  DropdownMenuItemProps,
} from './primitives/DropdownMenu';
export { Dropzone } from './primitives/Dropzone';
export type { DropzoneProps } from './primitives/Dropzone';
export { FocusRing, focusRingClassName } from './primitives/FocusRing';
export type { FocusRingProps } from './primitives/FocusRing';
export { IconButton } from './primitives/IconButton';
export type { IconButtonProps } from './primitives/IconButton';
export {
  AccountIcon,
  AlertIcon,
  ArrowLeftIcon,
  CheckIcon,
  CopyIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CloseIcon,
  HistoryIcon,
  MenuIcon,
  MinusIcon,
  MoreIcon,
  SearchIcon,
  ShareIcon,
  TrashIcon,
  UploadIcon,
} from './primitives/icons';
export { COPY_FEEDBACK_MS, CopyButton } from './primitives/CopyButton';
export type { CopyButtonProps } from './primitives/CopyButton';
export { Input } from './primitives/Input';
export type { InputProps } from './primitives/Input';
export {
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from './primitives/Popover';
export type { PopoverContentProps } from './primitives/Popover';
export { RadioGroup } from './primitives/RadioGroup';
export type { RadioGroupProps, RadioOption } from './primitives/RadioGroup';
export { Select } from './primitives/Select';
export type { SelectOption, SelectProps } from './primitives/Select';
export { Skeleton } from './primitives/Skeleton';
export type { SkeletonProps } from './primitives/Skeleton';
export { GlassSurface, Surface } from './primitives/Surface';
export type { GlassSurfaceProps, SurfacePadding, SurfaceProps } from './primitives/Surface';
export { Switch } from './primitives/Switch';
export type { SwitchProps } from './primitives/Switch';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './primitives/Tabs';
export type {
  TabsContentProps,
  TabsListProps,
  TabsProps,
  TabsTriggerProps,
} from './primitives/Tabs';
export { Textarea } from './primitives/Textarea';
export type { TextareaProps } from './primitives/Textarea';
export { Tooltip } from './primitives/Tooltip';
export { PreviewTooltip } from './primitives/PreviewTooltip';
export type { PreviewTooltipMode, PreviewTooltipProps } from './primitives/PreviewTooltip';
export {
  PREVIEW_CLOSE_MS,
  PREVIEW_LONG_PRESS_MS,
  TOOLTIP_DELAY_MS,
  TOOLTIP_DESCRIPTION_DELAY_MS,
} from './primitives/tooltip-delay';
export type { TooltipProps } from './primitives/Tooltip';

export { EmptyState } from './feedback/EmptyState';
export type { EmptyStateProps } from './feedback/EmptyState';
export { ProgressBar } from './feedback/ProgressBar';
export type { ProgressBarProps } from './feedback/ProgressBar';
export { StepProgress } from './feedback/StepProgress';
export type { ProgressStep, StepProgressProps } from './feedback/StepProgress';
export { ToastProvider, useToast } from './feedback/Toast';
export type { ToastOptions, ToastProviderProps, ToastTone } from './feedback/Toast';

export { BackLink, Breadcrumb } from './layout/Breadcrumb';
export type {
  BackLinkProps,
  BreadcrumbItem,
  BreadcrumbProps,
  LinkComponent,
} from './layout/Breadcrumb';
export { AppShell } from './layout/AppShell';
export type { AppShellProps } from './layout/AppShell';
export { ConfirmDialog } from './layout/ConfirmDialog';
export type { ConfirmDialogProps } from './layout/ConfirmDialog';
export { FloatingSidePanel } from './layout/FloatingSidePanel';
export type { FloatingSidePanelProps, PanelSteps } from './layout/FloatingSidePanel';
export { usePairedSheet } from './layout/paired-sheet';
export { DialogClose, ModalDialog } from './layout/ModalDialog';
export { ownEscapeProps } from './internal/own-escape';
export { useUnsavedChanges } from './internal/dirty';
export type { ModalDialogProps } from './layout/ModalDialog';
export { PageHeader } from './layout/PageHeader';
export type { PageHeaderProps } from './layout/PageHeader';
export { SplitView } from './layout/SplitView';
export type { SplitViewOrientation, SplitViewProps } from './layout/SplitView';

export {
  QUESTION_DOT_STATUSES,
  deriveDotStatus,
  questionDotLabel,
  questionStatusLabels,
  questionTypeLabels,
  summarizeStatuses,
} from './questions/status';
export type {
  LastGradedResult,
  QuestionDotStatus,
  QuestionLabelInput,
  QuestionStatusCounts,
  QuestionType,
  UserStudyState,
} from './questions/status';
export { QuestionMarker } from './questions/QuestionMarker';
export type { QuestionMarkerProps } from './questions/QuestionMarker';
export { QuestionDot } from './questions/QuestionDot';
export { focusQuestionDotQuietly } from './questions/quiet-focus';
export type { QuestionDotProps } from './questions/QuestionDot';
export { QuestionHeatmap } from './questions/QuestionHeatmap';
export type {
  HeatmapChapter,
  HeatmapQuestion,
  QuestionHeatmapProps,
} from './questions/QuestionHeatmap';
export { QuestionPreviewPopover } from './questions/QuestionPreviewPopover';
export type { QuestionPreviewPopoverProps } from './questions/QuestionPreviewPopover';
export { HeatmapLegend } from './questions/HeatmapLegend';
export type { HeatmapLegendProps } from './questions/HeatmapLegend';
export { StatusSummary } from './questions/StatusSummary';
export type { StatusSummaryProps } from './questions/StatusSummary';
export { FavoriteToggle, RetryToggle } from './questions/StudyToggles';
export type { StudyToggleProps } from './questions/StudyToggles';
export { RetryIcon, StarIcon } from './questions/icons';

export {
  HighlightableText,
  SearchMatchText,
  TOUCH_SELECTION_REST_MS,
} from './reading/HighlightableText';
export type {
  HighlightableTextProps,
  HighlightBlockElement,
  RenderHighlightBlock,
} from './reading/HighlightableText';
export { HIGHLIGHT_MENU_TEXT, HighlightMenu } from './reading/HighlightMenu';
export type { HighlightMenuProps } from './reading/HighlightMenu';
export {
  POINTER_FLOATING_CLOSE_MS,
  PointerAnchoredFloating,
} from './reading/PointerAnchoredFloating';
export type {
  PointerAnchoredFloatingProps,
  PointerFloatingMode,
} from './reading/PointerAnchoredFloating';
export { SEARCH_DEBOUNCE_MS, SEARCH_FIELD_TEXT, SearchField } from './reading/SearchField';
export type { SearchFieldProps } from './reading/SearchField';
export {
  HIGHLIGHT_COLORS,
  colorAction,
  drawableHighlights,
  exactHighlight,
  highlightColorLabels,
  overlappingHighlights,
} from './reading/model';
export type {
  HighlightAction,
  HighlightColor,
  HighlightSelection,
  SelectionSource,
  TextBlock,
  TextEmphasis,
  TextHighlight,
  TextMatch,
  TextRange,
} from './reading/model';
export {
  FIND_IN_NOTE_LIMIT,
  findInNote,
  foldForSearch,
  matchCountLabel,
} from './reading/find-in-note';
export type { FindBlock, FindResult, FoundMatch } from './reading/find-in-note';

export { useModalLayerOpen } from './internal/layer';
