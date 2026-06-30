import { loadConfig } from './config/index.js';
import { startBot } from './discord/client.js';
import { parseEnv, type Env } from './env.js';
import { loadEnvForApp, type LoadedEnvInfo } from './load-env.js';
import { createLogger } from './logger.js';
import { acquireSingleInstance, DEFAULT_PID_FILE_PATH } from './single-instance.js';

/**
 * エントリポイント。env 検証 → logger → Discord ログイン → config 読込 → 待機。
 * 致命的エラーでも process.exit() は呼ばない (CLAUDE.me: 常駐維持)。
 * 起動失敗時のみ exitCode を立てて main を抜け、systemd の自動再起動に委ねる。
 */
async function main(): Promise<void> {
  // env 検証前はレベル不明のため固定 info のブートロガーを使う。
  const bootLogger = createLogger('info');

  // NODE_ENV で動作環境を判定し、対応する env ファイル (.env / .env.staging) を
  // process.env へ読み込む。--env-file 相当の処理をコード側に一本化している。
  let loaded: LoadedEnvInfo;
  try {
    loaded = loadEnvForApp();
  } catch (err) {
    bootLogger.fatal({ err }, 'env ファイルの読み込みに失敗しました');
    process.exitCode = 1;
    return;
  }

  let env: Env;
  try {
    env = parseEnv();
  } catch (err) {
    bootLogger.fatal({ err }, '環境変数の検証に失敗しました');
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(env.LOG_LEVEL);
  // どの環境・どの env ファイルで起動したかを残す (本番/テストの取り違え防止)。
  logger.info({ appEnv: loaded.appEnv, envFile: loaded.envFile }, 'co-workingCall bot 起動中');

  // 多重起動防止 (pidfile)。同じトークンの bot が並走すると Discord Gateway 上で
  // 同じ voiceStateUpdate / interaction を両プロセスが処理し、Embed 投稿が
  // 重複する事故を起こすため起動時に弾く。
  const lock = acquireSingleInstance({ pidFilePath: DEFAULT_PID_FILE_PATH, logger });
  if (!lock.acquired) {
    process.exitCode = 1;
    return;
  }
  process.on('exit', lock.release);
  process.once('SIGTERM', () => {
    lock.release();
    process.exit(0);
  });
  process.once('SIGINT', () => {
    lock.release();
    process.exit(0);
  });

  try {
    await startBot(env.DISCORD_TOKEN, logger, env.CONFIG_PATH);
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
