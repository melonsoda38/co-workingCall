import { z } from 'zod';

/**
 * 環境変数スキーマ (.env)。spec.md L108-111 準拠。
 * US-4 では最小限。US-5 で config.json 検証と統合・拡張する。
 */
export const EnvSchema = z.object({
  DISCORD_TOKEN: z.string().min(1, 'DISCORD_TOKEN は必須です'),
  CONFIG_PATH: z.string().min(1).default('./config.json'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * process.env を検証して返す。検証失敗時は ZodError を投げるので、
 * 呼び出し側で fatal ログを出し非ゼロ終了する (systemd が再起動)。
 * テスト時は source を注入する。
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
