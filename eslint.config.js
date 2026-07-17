// ESLint flat config — the recommended rule sets for JS + TypeScript, with type-aware linting
// (typescript-eslint's recommendedTypeChecked) scoped to the TS sources so the linter uses the
// type information, not just the syntax.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'build/**', 'node_modules/**', '_site/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // node:test's `test()` returns a promise the runner tracks; not awaiting it is idiomatic.
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    // This config file is a Node ESM module, not part of the browser TS program.
    files: ['eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
);
