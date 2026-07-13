import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  BotConfigSchema,
  GuildConfigFileSchema,
  toBotConfigs,
  upsertVc,
  type BotConfig,
  type GuildConfigFile,
} from '@co-working-call/shared';
import type { Logger } from 'pino';
import { validate } from './validate.js';

/**
 * config 読み込み結果 (VC 単位のフラット BotConfig)。
 * - missing: ファイル不在 or 当該 VC 未設定 (初回起動、正常。待機)
 * - invalid: JSON 構文エラー / zod 検証エラー (要警告、/pomo init で復旧)
 * - ok: 検証済み BotConfig
 */
export type ConfigLoadResult =
  | { status: 'ok'; config: BotConfig }
  | { status: 'missing' }
  | { status: 'invalid'; issues: string[] };

/** guild ファイル (config/<guildId>.json) の読み込み結果。 */
export type GuildConfigLoadResult =
  | { status: 'ok'; file: GuildConfigFile }
  | { status: 'missing' }
  | { status: 'invalid'; issues: string[] };

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * guildId として許容する形式 (Discord snowflake = 数字のみ)。
 * ファイル名に使うため、`../` やパス区切りを含む値を根本から排除する (path traversal 対策)。
 */
const GUILD_ID_PATTERN = /^\d+$/;

/** guildId が Discord snowflake 形式 (数字のみ) かを判定する。 */
export function isValidGuildId(guildId: string): boolean {
  return GUILD_ID_PATTERN.test(guildId);
}

/**
 * guild ファイルのパスを求める (config/<guildId>.json)。
 * guildId は数字のみ許容。それ以外はファイル名経由の path traversal になり得るため例外にする。
 */
export function guildConfigPath(configDir: string, guildId: string): string {
  if (!isValidGuildId(guildId)) {
    throw new Error(`不正な guildId です (数字のみ許容): ${guildId}`);
  }
  return join(configDir, `${guildId}.json`);
}

/**
 * 任意のパスから 1 個のフラット BotConfig を読み込み検証する (旧 config.json 形式)。
 * 現在は移行 (migrateLegacyConfig) 専用の低レベルヘルパ。例外は投げず結果を返す。
 */
export async function loadConfig(path: string): Promise<ConfigLoadResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'invalid', issues: [`読み込み失敗: ${toMessage(err)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return { status: 'invalid', issues: [`JSON 構文エラー: ${toMessage(err)}`] };
  }

  const result = validate(BotConfigSchema, parsed);
  if (!result.ok) {
    return { status: 'invalid', issues: result.issues };
  }
  return { status: 'ok', config: result.data };
}

/**
 * guild ファイル (config/<guildId>.json) を読み込み GuildConfigFile として検証する。
 * 例外は投げず結果を返すので、呼び出し側が待機/警告を選択できる。
 */
export async function loadGuildConfigFile(
  configDir: string,
  guildId: string,
): Promise<GuildConfigLoadResult> {
  let raw: string;
  try {
    raw = await readFile(guildConfigPath(configDir, guildId), 'utf8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'invalid', issues: [`読み込み失敗: ${toMessage(err)}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return { status: 'invalid', issues: [`JSON 構文エラー: ${toMessage(err)}`] };
  }

  const result = validate(GuildConfigFileSchema, parsed);
  if (!result.ok) {
    return { status: 'invalid', issues: result.issues };
  }
  return { status: 'ok', file: result.data };
}

/**
 * guild ファイルから 1 VC 分のフラット BotConfig を合成して返す。
 * ファイル不在 or 当該 VC 未登録なら missing。ハンドラの旧 loadConfig(configPath) 置換用。
 */
export async function loadVcConfig(
  configDir: string,
  guildId: string,
  voiceChannelId: string,
): Promise<ConfigLoadResult> {
  const result = await loadGuildConfigFile(configDir, guildId);
  if (result.status !== 'ok') {
    return result;
  }
  const config = toBotConfigs(result.file).find((c) => c.voiceChannelId === voiceChannelId);
  return config ? { status: 'ok', config } : { status: 'missing' };
}

/**
 * フラット BotConfig を guild ファイルへ atomic に反映する (同ディレクトリの一時ファイル → rename)。
 * 既存ファイルがあれば読み込んで upsertVc で当該 VC を差し替え/追加する
 * (same-guild 複数VC 同居アルゴリズム)。ハンドラの旧 saveConfig(configPath) 置換用。
 */
export async function saveVcConfig(configDir: string, config: BotConfig): Promise<void> {
  const existing = await loadGuildConfigFile(configDir, config.guildId);
  const base = existing.status === 'ok' ? existing.file : null;
  const file = upsertVc(base, config);

  await mkdir(configDir, { recursive: true });
  const path = guildConfigPath(configDir, config.guildId);
  const tmp = join(configDir, `.${config.guildId}.${String(process.pid)}.tmp`);
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}

/**
 * config ディレクトリ内の全 guild ファイルを走査し、全 VC のフラット BotConfig を返す。
 * 起動時のマルチロード用。読み込めない/不正なファイルはスキップして warn する。
 */
export async function loadAllGuildConfigs(
  configDir: string,
  logger?: Logger,
): Promise<{ guildId: string; config: BotConfig }[]> {
  let entries: string[];
  try {
    entries = await readdir(configDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return [];
    }
    logger?.warn({ err, configDir }, 'config ディレクトリの走査に失敗しました');
    return [];
  }

  const result: { guildId: string; config: BotConfig }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const guildId = entry.slice(0, -'.json'.length);
    // guildId (=ファイル名の stem) が snowflake 形式でないものは対象外としてスキップ
    // (guildConfigPath の例外を避けつつ、想定外ファイルを無視する)。
    if (!isValidGuildId(guildId)) {
      continue;
    }
    const loaded = await loadGuildConfigFile(configDir, guildId);
    if (loaded.status === 'invalid') {
      logger?.warn({ guildId, issues: loaded.issues }, 'guild config が不正なためスキップ');
      continue;
    }
    if (loaded.status !== 'ok') {
      continue;
    }
    for (const config of toBotConfigs(loaded.file)) {
      result.push({ guildId: loaded.file.guildId, config });
    }
  }
  return result;
}

/**
 * 旧単一 config.json (フラット BotConfig) を新 per-guild ファイルへ 1 回だけ移行する。
 * 旧ファイルが存在し有効なら saveVcConfig で <configDir>/<guildId>.json に書き込み、
 * 旧ファイルを config.json.migrated へ rename する。不在/不正時は何もしない (破壊しない)。
 * @returns 移行を行ったら true。
 */
export async function migrateLegacyConfig(
  legacyPath: string,
  configDir: string,
  logger?: Logger,
): Promise<boolean> {
  const legacy = await loadConfig(legacyPath);
  if (legacy.status === 'missing') {
    return false;
  }
  if (legacy.status === 'invalid') {
    logger?.warn({ issues: legacy.issues, legacyPath }, '旧 config.json が不正なため移行をスキップ');
    return false;
  }

  // 既に per-guild ファイルがあれば上書きしない (移行済み or 手動作成を尊重)。
  const existing = await loadGuildConfigFile(configDir, legacy.config.guildId);
  if (existing.status === 'ok') {
    logger?.info(
      { guildId: legacy.config.guildId },
      'per-guild config が既に存在するため旧 config.json の移行はスキップ',
    );
  } else {
    await saveVcConfig(configDir, legacy.config);
    logger?.info(
      { guildId: legacy.config.guildId, configDir },
      '旧 config.json を per-guild ファイルへ移行しました',
    );
  }

  // 旧ファイルは .migrated へ退避して次回以降の再移行を防ぐ。
  try {
    await rename(legacyPath, `${legacyPath}.migrated`);
  } catch (err) {
    logger?.warn({ err, legacyPath }, '旧 config.json の退避 (.migrated) に失敗しました');
  }
  return true;
}

/**
 * configDir を CONFIG_PATH から導出する (<CONFIG_PATH の拡張子除去名>.guilds)。
 * 例: ./config.json → ./config.guilds、./config.staging.json → ./config.staging.guilds。
 * config.json / config.staging.json を別ディレクトリに分けて本番とテストの guild 設定を分離する。
 */
export function resolveConfigDir(legacyPath: string): string {
  const stem = basename(legacyPath).replace(/\.json$/i, '');
  return join(dirname(legacyPath), `${stem}.guilds`);
}
