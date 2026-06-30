import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 動作環境の名前。production = 本番 (Raspberry Pi)、staging = このマシンでのテスト。
 */
export type AppEnvName = 'production' | 'staging';

/**
 * NODE_ENV から動作環境を判定する純関数。
 * 'production' の時だけ本番。それ以外 ('staging'・未設定・想定外の値) は全て
 * staging 扱いにする。安全側に倒す設計で、NODE_ENV の設定漏れがあっても
 * 誤って本番トークン (.env) を使わない。
 * - 本番 (Pi): systemd に NODE_ENV=production を設定
 * - ローカル: package.json の dev に NODE_ENV=staging を埋め込む
 */
export function resolveAppEnv(nodeEnv: string | undefined = process.env.NODE_ENV): AppEnvName {
  return nodeEnv === 'production' ? 'production' : 'staging';
}

/**
 * 動作環境ごとに読み込む env ファイル名を返す。
 * production は既存の .env をそのまま使う (本番環境のファイルには手を加えない)。
 * staging はこのマシンでのテスト用 .env.staging (テスト版 app の Token と
 * CONFIG_PATH=./config.staging.json を持つ)。
 */
export function resolveEnvFileName(appEnv: AppEnvName): string {
  return appEnv === 'production' ? '.env' : '.env.staging';
}

/** loadEnvForApp が読み込んだ結果。起動ログで取り違え防止に出す。 */
export interface LoadedEnvInfo {
  appEnv: AppEnvName;
  envFile: string;
}

/**
 * NODE_ENV で環境を判定し、対応する env ファイルを process.env へ読み込む。
 * Node 22 の process.loadEnvFile を使う (起動コマンドの --env-file を置き換え、
 * 読み込み先の決定をコード側に一本化する)。
 * NODE_ENV 自体は env ファイルの外 (systemd / package.json) で設定された値を見る。
 * ファイルが無ければ Error を投げる (呼び出し側で fatal ログ → 非ゼロ終了)。
 */
export function loadEnvForApp(baseDir: string = process.cwd()): LoadedEnvInfo {
  const appEnv = resolveAppEnv();
  const envFile = resolveEnvFileName(appEnv);
  const path = resolve(baseDir, envFile);
  if (!existsSync(path)) {
    throw new Error(
      `env ファイルが見つかりません: ${path} ` +
        `(NODE_ENV=${process.env.NODE_ENV ?? '(未設定)'} → ${appEnv} 環境)`,
    );
  }
  process.loadEnvFile(path);
  return { appEnv, envFile };
}
