// Root ESLint flat config shared by every TypeScript package in the monorepo.
// Packages add framework-specific blocks (Next.js, React, Storybook, typed rules) here,
// scoped by `files`, rather than shipping their own config.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
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
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
