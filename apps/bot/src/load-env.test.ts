import { describe, expect, it } from 'vitest';
import { resolveAppEnv, resolveEnvFileName } from './load-env.js';

describe('load-env', () => {
  describe('resolveAppEnv', () => {
    it('NODE_ENV=production なら production', () => {
      expect(resolveAppEnv('production')).toBe('production');
    });

    it('NODE_ENV=staging なら staging', () => {
      expect(resolveAppEnv('staging')).toBe('staging');
    });

    it('未設定 (undefined) は安全側で staging', () => {
      expect(resolveAppEnv(undefined)).toBe('staging');
    });

    it('想定外の値も安全側で staging (誤って本番 .env を使わない)', () => {
      expect(resolveAppEnv('')).toBe('staging');
      expect(resolveAppEnv('prod')).toBe('staging');
      expect(resolveAppEnv('development')).toBe('staging');
    });
  });

  describe('resolveEnvFileName', () => {
    it('production は既存の .env を使う (本番ファイルは変更しない)', () => {
      expect(resolveEnvFileName('production')).toBe('.env');
    });

    it('staging はテスト用 .env.staging を使う', () => {
      expect(resolveEnvFileName('staging')).toBe('.env.staging');
    });
  });
});
