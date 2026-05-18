import { z } from 'zod';
import { validate } from './config/validate.js';

/** 空文字・空白のみは「未設定」とみなし undefined に変換する。 */
const emptyToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

/**
 * 環境変数スキーマ (.env)。spec.md L108-111 準拠。
 * 値が空のキー (例: .env.example をコピーしただけの CONFIG_PATH=) は
 * 未設定扱いにして既定値を適用する (US-4 のバグ修正)。
 */
export const EnvSchema = z.object({
  DISCORD_TOKEN: z.preprocess(emptyToUndefined, z.string().min(1, 'DISCORD_TOKEN は必須です')),
  CONFIG_PATH: z.preprocess(emptyToUndefined, z.string().min(1).default('./config.json')),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  ),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * process.env を検証して返す。env は起動必須のため無効時は Error を投げる
 * (呼び出し側で fatal ログ → 非ゼロ終了。systemd が再起動)。
 * config と同じ validate ヘルパで検証する (「同じ仕組み」)。
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = validate(EnvSchema, source);
  if (!result.ok) {
    throw new Error(`環境変数の検証に失敗しました:\n- ${result.issues.join('\n- ')}`);
  }
  return result.data;
}
