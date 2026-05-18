import { describe, expect, it } from 'vitest';
import { EnvSchema, parseEnv } from './env.js';

describe('EnvSchema / parseEnv', () => {
  it('DISCORD_TOKEN があれば既定値で補完される', () => {
    const env = parseEnv({ DISCORD_TOKEN: 'abc' });
    expect(env.DISCORD_TOKEN).toBe('abc');
    expect(env.CONFIG_PATH).toBe('./config.json');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('空文字の CONFIG_PATH / LOG_LEVEL は既定値で補完される (US-4 バグの回帰防止)', () => {
    const env = parseEnv({ DISCORD_TOKEN: 'abc', CONFIG_PATH: '', LOG_LEVEL: '' });
    expect(env.CONFIG_PATH).toBe('./config.json');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('空白のみの値も未設定扱いになる', () => {
    const env = parseEnv({ DISCORD_TOKEN: 'abc', CONFIG_PATH: '   ' });
    expect(env.CONFIG_PATH).toBe('./config.json');
  });

  it('DISCORD_TOKEN が無い / 空ならエラー', () => {
    expect(EnvSchema.safeParse({}).success).toBe(false);
    expect(EnvSchema.safeParse({ DISCORD_TOKEN: '' }).success).toBe(false);
    expect(() => parseEnv({})).toThrow(/環境変数の検証に失敗/);
  });

  it('LOG_LEVEL は列挙値のみ受理する', () => {
    expect(parseEnv({ DISCORD_TOKEN: 'x', LOG_LEVEL: 'debug' }).LOG_LEVEL).toBe('debug');
    expect(EnvSchema.safeParse({ DISCORD_TOKEN: 'x', LOG_LEVEL: 'verbose' }).success).toBe(false);
    expect(() => parseEnv({ DISCORD_TOKEN: 'x', LOG_LEVEL: 'verbose' })).toThrow();
  });

  it('CONFIG_PATH を指定できる', () => {
    expect(parseEnv({ DISCORD_TOKEN: 'x', CONFIG_PATH: './c.json' }).CONFIG_PATH).toBe('./c.json');
  });
});
