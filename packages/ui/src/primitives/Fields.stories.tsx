import type { Meta, StoryObj } from '@storybook/react-vite';
import { Checkbox } from './Checkbox';
import { Input } from './Input';
import { RadioGroup } from './RadioGroup';
import { Select } from './Select';
import { Textarea } from './Textarea';

const stack = { display: 'grid', gap: 'var(--space-5)', maxWidth: 360 } as const;

const meta = {
  title: 'Foundation/Input',
  component: Input,
  args: { label: '이메일', placeholder: 'name@example.com' },
  parameters: {
    docs: {
      description: {
        component:
          'Labelled text field. `description` and `error` are linked through aria-describedby; ' +
          '`error` sets aria-invalid/aria-errormessage and is shown with an icon and a thicker ' +
          'border, never by color alone. Tokens: --color-surface, --color-text-*, --color-focus.',
      },
    },
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const WithDescription: Story = { args: { description: '로그인에 사용하는 주소입니다.' } };
export const Hover: Story = { parameters: { pseudo: { hover: true } } };
export const Focus: Story = { parameters: { pseudo: { focusVisible: true } } };
export const Disabled: Story = { args: { disabled: true, value: 'name@example.com' } };
export const ErrorState: Story = {
  name: 'Error',
  args: { defaultValue: 'name@', error: '이메일 형식이 올바르지 않습니다.' },
};
export const HiddenLabel: Story = { args: { label: '검색', hideLabel: true, placeholder: '검색' } };
export const Dark: Story = { ...ErrorState, globals: { theme: 'dark' } };

export const TextareaStates: Story = {
  render: () => (
    <div style={stack}>
      <Textarea label="메모" placeholder="메모를 입력하세요" />
      <Textarea label="해설" error="해설은 10자 이상이어야 합니다." defaultValue="짧음" />
      <Textarea label="비활성" disabled defaultValue="수정할 수 없습니다." />
    </div>
  ),
};

export const CheckboxStates: Story = {
  render: () => (
    <div style={stack}>
      <Checkbox label="로그인 상태 유지" />
      <Checkbox
        label="Fork 허용"
        description="링크를 받은 사용자가 복제할 수 있습니다."
        defaultChecked
      />
      <Checkbox label="전체 선택" checked="indeterminate" />
      <Checkbox label="비활성" disabled />
    </div>
  ),
};

export const CheckboxFocus: Story = {
  ...CheckboxStates,
  parameters: { pseudo: { focusVisible: true } },
};

const TYPE_OPTIONS = [
  { value: 'ALL', label: '전체 유형' },
  { value: 'MCQ', label: '객관식' },
  { value: 'SHORT_ANSWER', label: '단답형' },
  { value: 'ESSAY', label: '서술형' },
];

/** Select: Radix combobox + listbox; the selected option carries a check mark. */
export const SelectStates: Story = {
  render: () => (
    <div style={stack}>
      <Select label="유형" options={TYPE_OPTIONS} defaultValue="ALL" />
      <Select label="챕터" options={TYPE_OPTIONS} placeholder="챕터 선택" />
      <Select label="오류" options={TYPE_OPTIONS} error="챕터를 선택해 주세요." />
      <Select label="비활성" options={TYPE_OPTIONS} defaultValue="MCQ" disabled />
    </div>
  ),
};

/** RadioGroup: one tab stop, Arrow keys move and select. */
export const RadioGroupStates: Story = {
  render: () => (
    <div style={stack}>
      <RadioGroup label="문제 유형" options={TYPE_OPTIONS.slice(1)} defaultValue="MCQ" />
      <RadioGroup
        label="세로 배치"
        orientation="vertical"
        options={TYPE_OPTIONS.slice(1)}
        defaultValue="ESSAY"
        error="유형을 선택해 주세요."
      />
      <RadioGroup label="비활성" options={TYPE_OPTIONS.slice(1)} defaultValue="MCQ" disabled />
    </div>
  ),
};
