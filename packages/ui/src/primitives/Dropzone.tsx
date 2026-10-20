'use client';

import {
  useId,
  useRef,
  useState,
  type DragEvent,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { cx } from '../internal/cx';
import { Button } from './Button';
import { UploadIcon } from './icons';

export interface DropzoneProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'title' | 'onDrop' | 'onDragEnter' | 'onDragOver' | 'onDragLeave'
> {
  /** Main line, e.g. "PDF 파일을 여기에 끌어다 놓으세요". */
  title: ReactNode;
  /** Secondary line (limits, accepted types). Linked to the pick button's description. */
  description?: ReactNode;
  /** Label of the file picker button (the keyboard and touch path). */
  buttonLabel?: ReactNode;
  /** Same syntax as `<input accept>`: extensions (`.pdf`) and MIME types (`application/pdf`, `image/*`). */
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  /** Chosen or dropped files that match `accept` (at most one unless `multiple`). */
  onFiles: (files: File[]) => void;
  /** Dropped files that do not match `accept` (the picker never offers them). */
  onReject?: (files: File[]) => void;
  /** Decorative icon; defaults to an upload tray. Pass `null` to omit it. */
  icon?: ReactNode;
}

function matchesAccept(file: File, accept: string | undefined): boolean {
  if (!accept?.trim()) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept
    .split(',')
    .map((rule) => rule.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => {
      if (rule.startsWith('.')) return name.endsWith(rule);
      if (rule.endsWith('/*')) return type.startsWith(rule.slice(0, -1));
      return type === rule;
    });
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

/**
 * File drop region (dashed border) with a real "파일 선택" button, so choosing a file never
 * depends on drag and drop (keyboard, touch, screen readers). Dragging files over it sets
 * `data-dragging`; dropped files are filtered by `accept` like the picker.
 */
export function Dropzone({
  title,
  description,
  buttonLabel = '파일 선택',
  accept,
  multiple = false,
  disabled = false,
  onFiles,
  onReject,
  icon,
  className,
  ...rest
}: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // dragenter/dragleave also fire for children: count the depth instead of toggling.
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const descriptionId = useId();

  const deliver = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    const accepted = files.filter((file) => matchesAccept(file, accept));
    const rejected = files.filter((file) => !matchesAccept(file, accept));
    const chosen = multiple ? accepted : accepted.slice(0, 1);
    if (chosen.length > 0) onFiles(chosen);
    if (rejected.length > 0) onReject?.(rejected);
  };

  const reset = () => {
    depth.current = 0;
    setDragging(false);
  };

  return (
    <div
      className={cx('qz-dropzone', className)}
      data-dragging={dragging || undefined}
      data-disabled={disabled || undefined}
      onDragEnter={(event) => {
        if (disabled || !hasFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        // Required for the drop event to fire. Also cancelled while disabled, so a file dropped
        // here never makes the browser open it and navigate away; the cursor says "no drop".
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
      }}
      onDragLeave={(event) => {
        if (disabled || !hasFiles(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        // Always cancel the native drop (the browser would open the file), even when disabled.
        if (hasFiles(event)) event.preventDefault();
        if (disabled) return;
        event.preventDefault();
        reset();
        deliver(event.dataTransfer?.files);
      }}
      {...rest}
    >
      {icon === null ? null : (
        <span className="icon" aria-hidden="true">
          {icon ?? <UploadIcon width={24} height={24} />}
        </span>
      )}
      <p className="title">{title}</p>
      {description ? (
        <p id={descriptionId} className="description">
          {description}
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        className="pick"
        disabled={disabled}
        aria-describedby={description ? descriptionId : undefined}
        onClick={() => inputRef.current?.click()}
      >
        {buttonLabel}
      </Button>
      <input
        ref={inputRef}
        type="file"
        className="qz-visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => {
          deliver(event.currentTarget.files);
          // Allow picking the same file again.
          event.currentTarget.value = '';
        }}
      />
    </div>
  );
}
