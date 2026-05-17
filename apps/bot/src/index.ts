import { startBot } from './discord/client.js';
import { parseEnv, type Env } from './env.js';
import { createLogger } from './logger.js';

/**
 * エントリポイント。env 検証 → logger → Discord ログイン → READY。
 * 致命的エラーでも process.exit() は呼ばない (CLAUDE.me: 常駐維持)。
 * 起動失敗時のみ exitCode を立てて main を抜け、systemd の自動再起動に委ねる。
 */
async function main(): Promise<void> {
  // env 検証前はレベル不明のため固定 info のブートロガーを使う。
  const bootLogger = createLogger('info');

  let env: Env;
  try {
    env = parseEnv();
  } catch (err) {
    bootLogger.fatal({ err }, '環境変数の検証に失敗しました');
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(env.LOG_LEVEL);
  logger.info('co-workingCall bot 起動中');

  try {
    await startBot(env.DISCORD_TOKEN, logger);
  } catch (err) {
    logger.fatal({ err }, 'Discord ログインに失敗しました');
    process.exitCode = 1;
  }
}

void main();
