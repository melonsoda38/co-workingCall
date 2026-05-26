import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { createLogger } from './logger.js';

describe('createLogger (US-21)', () => {
  let originalIsTTY: boolean | undefined;
  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    // 非 TTY (JSON 出力) を強制してテストを安定させる。
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true });
  });

  it('指定した level を反映する', () => {
    expect(createLogger('debug').level).toBe('debug');
    expect(createLogger('info').level).toBe('info');
    expect(createLogger('warn').level).toBe('warn');
  });
});

/**
 * createLogger と同じ仕様 (base + redact paths + censor) を destination ストリーム
 * 経由で実出力に対して検証する。pino の bindings() は root logger では base を返さない
 * ため、実 stream 出力を JSON パースして確認するのが確実。
 */
describe('logger.ts と同じ base + redact 仕様 (US-21)', () => {
  function captureLog(): { logger: pino.Logger; lines: string[] } {
    const lines: string[] = [];
    const dest: pino.DestinationStream = {
      write(s: string): void {
        lines.push(s);
      },
    };
    const logger = pino(
      {
        level: 'info',
        base: { app: 'co-workingCall', pid: process.pid, hostname: 'test-host' },
        redact: {
          paths: [
            'token',
            '*.token',
            'DISCORD_TOKEN',
            '*.DISCORD_TOKEN',
            'authorization',
            '*.authorization',
            'Authorization',
            '*.Authorization',
          ],
          censor: '[REDACTED]',
        },
      },
      dest,
    );
    return { logger, lines };
  }

  it('base に app=co-workingCall / pid / hostname を含むログを出力する', () => {
    const { logger, lines } = captureLog();
    logger.info('test');
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry.app).toBe('co-workingCall');
    expect(entry.pid).toBe(process.pid);
    expect(entry.hostname).toBe('test-host');
  });

  it('top-level の token / DISCORD_TOKEN / authorization は [REDACTED] に置換される', () => {
    const { logger, lines } = captureLog();
    logger.info({ token: 'secret', DISCORD_TOKEN: 'xxx', authorization: 'Bearer xxx' }, 'test');
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry.token).toBe('[REDACTED]');
    expect(entry.DISCORD_TOKEN).toBe('[REDACTED]');
    expect(entry.authorization).toBe('[REDACTED]');
  });

  it('ネストされた *.token も伏字化される', () => {
    const { logger, lines } = captureLog();
    logger.info({ env: { token: 'leak' } }, 'test');
    const entry = JSON.parse(lines[0] ?? '{}') as { env?: { token?: string } };
    expect(entry.env?.token).toBe('[REDACTED]');
  });

  it('対象外フィールド (例: guildId) はそのまま残る', () => {
    const { logger, lines } = captureLog();
    logger.info({ guildId: 'g-1', userId: 'u-2' }, 'test');
    const entry = JSON.parse(lines[0] ?? '{}') as { guildId?: string; userId?: string };
    expect(entry.guildId).toBe('g-1');
    expect(entry.userId).toBe('u-2');
  });
});
