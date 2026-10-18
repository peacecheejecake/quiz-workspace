import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs', '@storybook/addon-a11y', 'storybook-addon-pseudo-states'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
  typescript: { reactDocgen: 'react-docgen-typescript' },
  viteFinal(viteConfig) {
    // Radix ships `'use client'` directives (for Next.js RSC); they are meaningless in the
    // Storybook bundle and would otherwise flood the build log.
    const build = (viteConfig.build ??= {});
    const rollupOptions = (build.rollupOptions ??= {});
    const previous = rollupOptions.onwarn;
    rollupOptions.onwarn = (warning, warn) => {
      if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
      if (previous) previous(warning, warn);
      else warn(warning);
    };
    return viteConfig;
  },
};

export default config;
