// ESLint flat config — the recommended rule sets for JS + TypeScript, with type-aware linting
// (typescript-eslint's recommendedTypeChecked) scoped to the TS sources so the linter uses the
// type information, not just the syntax.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '_site/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // This config file is a Node ESM module, not part of the browser TS program.
    files: ['eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
);
