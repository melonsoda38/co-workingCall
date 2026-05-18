import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BotConfigSchema, type BotConfig } from '@co-working-call/shared';
import { validate } from './validate.js';

/**
 * config.json 読み込み結果。
 * - missing: ファイル不在 (初回起動、正常。待機)
 * - invalid: JSON 構文エラー / zod 検証エラー (要警告、/pomo init で復旧)
 * - ok: 検証済み BotConfig
 */
export type ConfigLoadResult =
  | { status: 'ok'; config: BotConfig }
  | { status: 'missing' }
  | { status: 'invalid'; issues: string[] };

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * config.json を読み込み検証する。例外は投げず結果を返すので、
 * 呼び出し側が idle 待機を選択できる (spec.md: 無効なら待機状態)。
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
 * config.json を atomic に書き込む (同ディレクトリの一時ファイル → rename)。
 * /pomo init (US-6) で使用する。
 */
export async function saveConfig(path: string, config: BotConfig): Promise<void> {
  const tmp = join(dirname(path), `.config.${String(process.pid)}.tmp`);
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await rename(tmp, path);
}
