import os from 'node:os';
import pino, { type Logger } from 'pino';
import type { Env } from './env.js';

/** structured log 共通メタデータ。systemd journal の grep / 検索を容易にする (US-21)。 */
const BASE_META = {
  app: 'co-workingCall',
  pid: process.pid,
  hostname: os.hostname(),
};

/**
 * 機密フィールドの伏字化対象 (US-21)。誤って logger に渡された場合の保険。
 * pino の redact paths: 完全一致と `*.key` (任意ネスト下) の組合せで Discord トークン
 * 系 / Authorization ヘッダ系をマスクする。
 */
const REDACT_PATHS = [
  'token',
  '*.token',
  'DISCORD_TOKEN',
  '*.DISCORD_TOKEN',
  'authorization',
  '*.authorization',
  'Authorization',
  '*.Authorization',
];

/**
 * pino ロガーを生成する。console.log は使わない (CLAUDE.me)。
 * 対話端末 (開発時) では pino-pretty で整形、
 * 非 TTY (systemd journal) では JSON のまま出力する。
 * redact で機密フィールドを伏字化し、base に app 名を入れて journal 検索しやすくする。
 */
export function createLogger(level: Env['LOG_LEVEL']): Logger {
  const usePretty = process.stdout.isTTY;
  return pino({
    level,
    base: BASE_META,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
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
