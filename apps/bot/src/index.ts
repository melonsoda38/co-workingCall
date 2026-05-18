import { loadConfig } from './config/index.js';
import { startBot } from './discord/client.js';
import { parseEnv, type Env } from './env.js';
import { createLogger } from './logger.js';

/**
 * エントリポイント。env 検証 → logger → Discord ログイン → config 読込 → 待機。
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
    return;
  }

  // config.json を検証。無効でも落とさず待機状態にする (spec.md)。
  const configResult = await loadConfig(env.CONFIG_PATH);
  switch (configResult.status) {
    case 'ok':
      logger.info(
        {
          guildId: configResult.config.guildId,
          voiceChannelId: configResult.config.voiceChannelId,
        },
        'config.json を読み込みました',
      );
      break;
    case 'missing':
      logger.info('config.json が無いため待機状態です (/pomo init で初期化してください)');
      break;
    case 'invalid':
      logger.warn(
        { issues: configResult.issues },
        'config.json が不正なため待機状態です (/pomo init で復旧してください)',
      );
      break;
  }
}

void main();
