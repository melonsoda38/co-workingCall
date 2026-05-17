import { describe, expect, it } from 'vitest';
import { EnvSchema, parseEnv } from './env.js';

describe('EnvSchema', () => {
  it('DISCORD_TOKEN があれば既定値で補完される', () => {
    const env = parseEnv({ DISCORD_TOKEN: 'abc' });
    expect(env.DISCORD_TOKEN).toBe('abc');
    expect(env.CONFIG_PATH).toBe('./config.json');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('DISCORD_TOKEN が無いと検証エラー', () => {
    expect(EnvSchema.safeParse({}).success).toBe(false);
  });

  it('DISCORD_TOKEN が空文字なら検証エラー', () => {
    expect(EnvSchema.safeParse({ DISCORD_TOKEN: '' }).success).toBe(false);
  });

  it('LOG_LEVEL は列挙値のみ受理する', () => {
    expect(parseEnv({ DISCORD_TOKEN: 'x', LOG_LEVEL: 'debug' }).LOG_LEVEL).toBe('debug');
    expect(EnvSchema.safeParse({ DISCORD_TOKEN: 'x', LOG_LEVEL: 'verbose' }).success).toBe(false);
  });

  it('CONFIG_PATH を指定できる', () => {
    expect(parseEnv({ DISCORD_TOKEN: 'x', CONFIG_PATH: './c.json' }).CONFIG_PATH).toBe('./c.json');
  });
});
