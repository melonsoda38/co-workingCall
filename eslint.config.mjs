import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// ESLint 9 flat config。
// CLAUDE.me の「TypeScript strict / any 禁止」を strictTypeChecked で担保する。
export default tseslint.config(
  {
    // ビルド成果物・依存・ルート設定ファイル(vitest)は対象外
    ignores: ['**/dist/**', '**/node_modules/**', 'vitest.config.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // 各パッケージの tsconfig を自動解決 (typescript-eslint v8)
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // JS/設定ファイルには型情報必須ルールを適用しない
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
