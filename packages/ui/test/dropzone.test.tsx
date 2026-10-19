import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dropzone } from '../src';
import { axeViolations } from './axe';

const pdf = (name = 'notes.pdf') => new File(['%PDF-1.7'], name, { type: 'application/pdf' });
const png = () => new File(['png'], 'cover.png', { type: 'image/png' });

/** A drag event carrying files (jsdom has no DataTransfer constructor). */
function drag(type: 'dragEnter' | 'dragOver' | 'dragLeave' | 'drop', el: Element, files: File[]) {
  const event = createEvent[type](el);
  Object.defineProperty(event, 'dataTransfer', {
    value: { files, types: ['Files'], dropEffect: 'none' },
  });
  fireEvent(el, event);
  return event;
}

function zone() {
  const el = document.querySelector('.qz-dropzone');
  if (!el) throw new Error('no dropzone');
  return el;
}

describe('Dropzone', () => {
  it('offers a real, described button that opens the file picker', async () => {
    const user = userEvent.setup();
    render(
      <Dropzone
        title="PDF 파일을 여기에 끌어다 놓으세요"
        description="PDF, 최대 50MB"
        accept=".pdf,application/pdf"
        onFiles={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: '파일 선택' });
    expect(button).toHaveAccessibleDescription('PDF, 최대 50MB');
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).toHaveAttribute('accept', '.pdf,application/pdf');
    expect(input).not.toHaveAttribute('multiple');
    expect(input).toHaveAttribute('tabindex', '-1');
    const click = vi.spyOn(input as HTMLInputElement, 'click');
    await user.tab();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(click).toHaveBeenCalledOnce();
    expect(await axeViolations()).toEqual([]);
  });

  it('reports picked files and lets the same file be picked again', async () => {
    const user = userEvent.setup();
    const onFiles = vi.fn();
    render(<Dropzone title="파일" accept=".pdf" multiple onFiles={onFiles} />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    const files = [pdf('a.pdf'), pdf('b.pdf')];
    await user.upload(input as HTMLInputElement, files);
    expect(onFiles).toHaveBeenCalledWith(files);
    expect(input?.value).toBe('');
  });

  it('shows the drag-over state across child elements and delivers dropped files', () => {
    const onFiles = vi.fn();
    const onReject = vi.fn();
    render(
      <Dropzone
        title="파일"
        description="설명"
        accept=".pdf"
        onFiles={onFiles}
        onReject={onReject}
      />,
    );
    const el = zone();
    const file = pdf();
    drag('dragEnter', el, [file]);
    expect(el).toHaveAttribute('data-dragging');
    // Entering a child then leaving it keeps the state; leaving the zone clears it.
    drag('dragEnter', screen.getByText('설명'), [file]);
    drag('dragLeave', screen.getByText('설명'), [file]);
    expect(el).toHaveAttribute('data-dragging');
    expect(drag('dragOver', el, [file]).defaultPrevented).toBe(true);
    const other = png();
    drag('drop', el, [file, other]);
    expect(el).not.toHaveAttribute('data-dragging');
    // Not `multiple`: one accepted file; files outside `accept` are reported separately.
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(onReject).toHaveBeenCalledWith([other]);
  });

  it('ignores drags and drops and disables the button when disabled', () => {
    const onFiles = vi.fn();
    render(<Dropzone title="파일" disabled onFiles={onFiles} />);
    const el = zone();
    expect(el).toHaveAttribute('data-disabled');
    expect(screen.getByRole('button', { name: '파일 선택' })).toBeDisabled();
    drag('dragEnter', el, [pdf()]);
    expect(el).not.toHaveAttribute('data-dragging');
    drag('drop', el, [pdf()]);
    expect(onFiles).not.toHaveBeenCalled();
  });
});
