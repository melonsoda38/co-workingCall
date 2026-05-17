import pino, { type Logger } from 'pino';
import type { Env } from './env.js';

/**
 * pino ロガーを生成する。console.log は使わない (CLAUDE.me)。
 * 対話端末 (開発時) では pino-pretty で整形、
 * 非 TTY (systemd journal) では JSON のまま出力する。
 */
export function createLogger(level: Env['LOG_LEVEL']): Logger {
  const usePretty = process.stdout.isTTY;
  return pino({
    level,
    ...(usePretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
        }
      : {}),
  });
}
