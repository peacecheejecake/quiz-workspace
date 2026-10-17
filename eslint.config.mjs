// Root ESLint flat config shared by every TypeScript package in the monorepo.
// Packages add framework-specific blocks (Next.js, React, Storybook, typed rules) here,
// scoped by `files`, rather than shipping their own config.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/storybook-static/**',
      '**/.venv/**',
      // Agent worktrees (other checkouts of this repo).
      '.claude/**',
      'playwright-report/**',
      'test-results/**',
      // Owned by P0.10 (Playwright harness); @playwright/test is not installed yet.
      'playwright.config.ts',
      'tests/e2e/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strict,
  tseslint.configs.stylistic,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
      // Pin the root so nested checkouts (.claude/worktrees) are never tsconfig candidates.
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  // React (packages/ui now, apps/web later): hooks rules + JSX accessibility for every JSX file.
  {
    files: ['**/*.{jsx,tsx}'],
    ...jsxA11y.flatConfigs.recommended,
  },
  {
    files: ['**/*.{jsx,tsx}'],
    ...reactHooks.configs.flat['recommended-latest'],
  },
  {
    files: ['packages/ui/**'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
