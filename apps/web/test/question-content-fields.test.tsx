// @vitest-environment jsdom
// The option list shared by the question, draft and mock exam editors (UX12-QEDIT): multi-line
// input, a pointer-only handle, and reordering through the kept 위로/아래로 buttons.
import './dom-setup';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';
import { QuestionContentFields } from '../src/components/questions/question-content-fields';
import { contentBody, emptyForm, type QuestionFormValues } from '../src/lib/questions/form';

function initial(): QuestionFormValues {
  const form = emptyForm(
    (
      (n) => () =>
        `opt-${(n += 1)}`
    )(0),
  );
  return {
    ...form,
    type: 'MCQ',
    stem: '문제',
    options: form.options.map((o, i) => ({ ...o, text: `보기 글자 ${i + 1}`, correct: i === 0 })),
  };
}

function Harness({ onChange }: { readonly onChange: (values: QuestionFormValues) => void }) {
  const [values, setValues] = useState(initial);
  const update: ComponentProps<typeof QuestionContentFields>['update'] = (next) => {
    setValues(next);
    onChange(next);
  };
  return <QuestionContentFields values={values} errors={{}} update={update} stemId="stem" />;
}

describe('QuestionContentFields options', () => {
  it('uses a multi-line input where Enter adds a line and does not submit', async () => {
    let latest = initial();
    let submitted = 0;
    render(
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submitted += 1;
        }}
      >
        <Harness onChange={(next) => (latest = next)} />
      </form>,
    );
    const field = screen.getByRole('textbox', { name: '보기 2' });
    expect(field.tagName).toBe('TEXTAREA');
    await userEvent.type(field, '{Enter}다음 줄');
    expect(latest.options[1]?.text).toBe('보기 글자 2\n다음 줄');
    expect(submitted).toBe(0);
  });

  it('hides the pointer-only handle from assistive technology and the tab order', () => {
    const { container } = render(<Harness onChange={() => undefined} />);
    const handles = container.querySelectorAll('[data-option-handle]');
    expect(handles).toHaveLength(4);
    for (const handle of handles) {
      expect(handle).toHaveAttribute('aria-hidden', 'true');
      expect(handle).not.toHaveAttribute('tabindex');
      expect(handle).not.toHaveAttribute('role');
    }
  });

  it('keeps ids and the answer on their option through the 아래로 button', async () => {
    let latest = initial();
    render(<Harness onChange={(next) => (latest = next)} />);
    await userEvent.click(screen.getByRole('button', { name: '보기 1 아래로 이동' }));
    const body = contentBody(latest);
    expect(body.options?.map((o) => o.id)).toEqual(['opt-2', 'opt-1', 'opt-3', 'opt-4']);
    expect(body.correct_option_ids).toEqual(['opt-1']);
    expect(screen.getByRole('checkbox', { name: '보기 2 정답' })).toBeChecked();
  });
});
