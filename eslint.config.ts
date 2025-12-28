// @ts-check
// Docs: https://eslint.org/docs/user-guide/configuring

import eslint from '@eslint/js'
import prettierConfig from 'eslint-config-prettier'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ignores: ['**/dist/**', '**/node_modules/**']
  },
  {
    languageOptions: {
      globals: {
        process: 'readonly'
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ['prettier.config.js', 'tailwind.config.ts', 'vite.config.ts']
        },
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked]
  },
  prettierConfig
)
