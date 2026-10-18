import type { Decorator, Preview } from '@storybook/react-vite';
import { ThemeProvider, type ThemePreference } from '../src';
import '../src/styles.css';

const withTheme: Decorator = (Story, context) => {
  const theme = (context.globals['theme'] as ThemePreference | undefined) ?? 'light';
  return (
    <ThemeProvider theme={theme}>
      <div className="qz-theme-scope" style={{ minHeight: '100vh', padding: 'var(--space-6)' }}>
        <Story />
      </div>
    </ThemeProvider>
  );
};

const preview: Preview = {
  decorators: [withTheme],
  globalTypes: {
    theme: {
      description: 'Token theme (data-theme on <html>)',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: true },
    // Fail the a11y panel on violations so regressions are visible while browsing.
    a11y: { test: 'error' },
  },
  tags: ['autodocs'],
};

export default preview;
