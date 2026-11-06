import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';

/**
 * The web app's QuestionViewer stories (QVIEW-01: every mode, light and dark) and the 모의고사 dialog's
 * (MOCK-01) live next to the components in apps/web and are built here, the repo's one Storybook. Their server actions and
 * next/link resolve to story stand-ins (apps/web/.../viewer/stories); `@/` is the web app's src.
 */
const WEB_SRC = fileURLToPath(new URL('../../../apps/web/src', import.meta.url));
const WEB_STORIES = `${WEB_SRC}/components/questions/viewer/stories`;

const config: StorybookConfig = {
  stories: [
    '../src/**/*.stories.@(ts|tsx)',
    '../../../apps/web/src/components/questions/viewer/*.stories.tsx',
    '../../../apps/web/src/components/questions/mock-exams/*.stories.tsx',
  ],
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
    const resolve = (viteConfig.resolve ??= {});
    const existing = Array.isArray(resolve.alias)
      ? resolve.alias
      : Object.entries(resolve.alias ?? {}).map(([find, replacement]) => ({
          find,
          replacement: String(replacement),
        }));
    resolve.alias = [
      { find: '@/lib/questions/practice-actions', replacement: `${WEB_STORIES}/story-server.ts` },
      {
        find: '@/lib/questions/practice-open-client',
        replacement: `${WEB_STORIES}/story-server.ts`,
      },
      { find: '@/lib/questions/actions', replacement: `${WEB_STORIES}/story-server.ts` },
      { find: /^next\/link$/, replacement: `${WEB_STORIES}/story-link.tsx` },
      { find: /^@\//, replacement: `${WEB_SRC}/` },
      ...existing,
    ];
    return viteConfig;
  },
};

export default config;
