// @vitest-environment jsdom
// UX12-SOLVEDOPEN-AC10: loading questions shows blocks, and only assistive technology gets words.
import './dom-setup';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  QuestionLineSkeleton,
  QuestionListSkeleton,
  QuestionSkeleton,
} from '../src/components/questions/question-skeleton';

const LOADING = '문제를 불러오는 중입니다.';

function expectHiddenStatus(): void {
  const status = screen.getByRole('status');
  expect(status).toHaveTextContent(LOADING);
  expect(status).toHaveClass('qz-visually-hidden');
}

describe('UX12-SOLVEDOPEN-AC10 question skeletons', () => {
  it('a question keeps the status name, in a busy region, with stem lines and option rows', () => {
    const { container } = render(<QuestionSkeleton />);
    expectHiddenStatus();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-shape="text"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-shape="rect"]')).toHaveLength(4);
  });

  it('a known stem replaces the lines', () => {
    const { container } = render(<QuestionSkeleton stem={<p>알려진 발문</p>} />);
    expect(within(container).getByText('알려진 발문')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-shape="text"]')).toHaveLength(0);
  });

  it('a question without options has an answer box', () => {
    const { container } = render(<QuestionSkeleton questionType="ESSAY" />);
    expect(container.querySelectorAll('[data-shape="rect"]')).toHaveLength(1);
  });

  it('a list has rows and the same status', () => {
    const { container } = render(<QuestionListSkeleton rows={5} />);
    expectHiddenStatus();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-shape="rect"]')).toHaveLength(5);
  });

  it('the home line announces through its own status', () => {
    render(
      <p role="status">
        <QuestionLineSkeleton />
      </p>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(LOADING);
    expect(screen.getByText(LOADING)).toHaveClass('qz-visually-hidden');
  });
});
