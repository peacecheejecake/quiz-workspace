// Public API of @quiz/ui. Styles ship separately: import '@quiz/ui/styles.css' once at the root.
export { ThemeProvider, useTheme } from './theme/ThemeProvider';
export type { ThemeContextValue, ThemePreference, ThemeProviderProps } from './theme/ThemeProvider';

export { Badge } from './primitives/Badge';
export type { BadgeProps, BadgeTone } from './primitives/Badge';
export { Button } from './primitives/Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './primitives/Button';
export { Checkbox } from './primitives/Checkbox';
export type { CheckboxProps } from './primitives/Checkbox';
export { FocusRing, focusRingClassName } from './primitives/FocusRing';
export type { FocusRingProps } from './primitives/FocusRing';
export { IconButton } from './primitives/IconButton';
export type { IconButtonProps } from './primitives/IconButton';
export { AlertIcon, CheckIcon, CloseIcon, MenuIcon, MinusIcon } from './primitives/icons';
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
export { Skeleton } from './primitives/Skeleton';
export type { SkeletonProps } from './primitives/Skeleton';
export { GlassSurface, Surface } from './primitives/Surface';
export type { GlassSurfaceProps, SurfacePadding, SurfaceProps } from './primitives/Surface';
export { Textarea } from './primitives/Textarea';
export type { TextareaProps } from './primitives/Textarea';
export { Tooltip } from './primitives/Tooltip';
export type { TooltipProps } from './primitives/Tooltip';

export { EmptyState } from './feedback/EmptyState';
export type { EmptyStateProps } from './feedback/EmptyState';
export { ToastProvider, useToast } from './feedback/Toast';
export type { ToastOptions, ToastProviderProps, ToastTone } from './feedback/Toast';

export { AppShell } from './layout/AppShell';
export type { AppShellProps } from './layout/AppShell';
export { FloatingSidePanel } from './layout/FloatingSidePanel';
export type { FloatingSidePanelProps } from './layout/FloatingSidePanel';
export { DialogClose, ModalDialog } from './layout/ModalDialog';
export type { ModalDialogProps } from './layout/ModalDialog';
export { PageHeader } from './layout/PageHeader';
export type { PageHeaderProps } from './layout/PageHeader';
