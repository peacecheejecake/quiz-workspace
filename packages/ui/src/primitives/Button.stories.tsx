import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { CloseIcon, MenuIcon } from './icons';

const row = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'var(--space-3)',
  alignItems: 'center',
} as const;

const meta = {
  title: 'Foundation/Button',
  component: Button,
  args: { children: '저장', variant: 'secondary', size: 'md' },
  parameters: {
    docs: {
      description: {
        component:
          'Text button. Variants: primary (one per view), secondary, ghost. Keyboard: Tab to ' +
          'focus (shared FocusRing), Enter/Space to activate. `loading` sets aria-busy and ' +
          'disables the button. Every variant has a hover distinct from pressed and selected: ' +
          'primary steps the fill (--color-accent-hover / -pressed), the others use ' +
          '--color-state-hover / -pressed, toggles on use --color-state-selected(-hover). Hover ' +
          'applies only to hover-capable pointers and never to disabled buttons. Toggles ' +
          '(aria-pressed) have no border or fill while off. Tokens: --color-accent(-hover, ' +
          '-pressed), --color-surface, --color-state-*, --color-border, --color-focus, ' +
          '--radius-md, --duration-state, --easing-standard.',
      },
    },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: (args) => (
    <div style={row}>
      <Button {...args} variant="primary">
        Primary
      </Button>
      <Button {...args} variant="secondary">
        Secondary
      </Button>
      <Button {...args} variant="ghost">
        Ghost
      </Button>
      <Button {...args} size="sm" variant="primary">
        Small
      </Button>
    </div>
  ),
};

export const Hover: Story = { ...Variants, parameters: { pseudo: { hover: true } } };
export const Focus: Story = { ...Variants, parameters: { pseudo: { focusVisible: true } } };
export const Active: Story = { ...Variants, parameters: { pseudo: { active: true } } };
export const Disabled: Story = { ...Variants, args: { disabled: true } };
export const Loading: Story = { args: { loading: true, variant: 'primary', children: '저장 중' } };

export const AsLink: Story = {
  args: { asChild: true, variant: 'primary', children: <a href="#workspaces">Workspace로 이동</a> },
};

export const Dark: Story = { ...Variants, globals: { theme: 'dark' } };
export const HoverDark: Story = { ...Hover, globals: { theme: 'dark' } };
export const ActiveDark: Story = { ...Active, globals: { theme: 'dark' } };

/** Toggle buttons: off = no border/fill, on = selected fill + semibold, exposed as aria-pressed. */
export const Toggles: Story = {
  render: (args) => (
    <div style={row}>
      <Button {...args} size="sm" aria-pressed={false}>
        꺼짐
      </Button>
      <Button {...args} size="sm" aria-pressed>
        켜짐
      </Button>
      <Button {...args} size="sm" variant="ghost">
        Ghost
      </Button>
    </div>
  ),
};

export const TogglesHover: Story = { ...Toggles, parameters: { pseudo: { hover: true } } };
export const TogglesActive: Story = { ...Toggles, parameters: { pseudo: { active: true } } };
export const TogglesDark: Story = { ...Toggles, globals: { theme: 'dark' } };
export const TogglesHoverDark: Story = { ...TogglesHover, globals: { theme: 'dark' } };

export const IconButtons: StoryObj<typeof IconButton> = {
  render: () => (
    <div style={row}>
      <IconButton label="닫기" icon={<CloseIcon />} />
      <IconButton label="메뉴" icon={<MenuIcon />} variant="secondary" />
      <IconButton label="메뉴" icon={<MenuIcon />} variant="primary" />
      <IconButton label="닫기" icon={<CloseIcon />} size="sm" />
      <IconButton label="닫기" icon={<CloseIcon />} disabled />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'IconButton requires `label` (type error without it, runtime error if empty); it ' +
          'becomes aria-label and the native title.',
      },
    },
  },
};

export const IconButtonsFocus: StoryObj<typeof IconButton> = {
  ...IconButtons,
  parameters: { pseudo: { focusVisible: true } },
};

export const IconButtonsHover: StoryObj<typeof IconButton> = {
  ...IconButtons,
  parameters: { pseudo: { hover: true } },
};

export const IconButtonsHoverDark: StoryObj<typeof IconButton> = {
  ...IconButtonsHover,
  globals: { theme: 'dark' },
};
