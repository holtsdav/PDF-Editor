import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import obsidian from 'eslint-plugin-obsidianmd';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['node_modules/**', 'main.js', 'dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } }
  },
  {
    files: ['src/**/*.ts'],
    plugins: { obsidianmd: obsidian },
    rules: {
      'obsidianmd/commands/no-plugin-id-in-command-id': 'error',
      'obsidianmd/commands/no-plugin-name-in-command-name': 'error',
      'obsidianmd/no-static-styles-assignment': 'error'
    }
  }
);
