import { z } from 'zod';
import { TimerConfigSchema } from './timer.js';

/**
 * 永続化設定 (config.json)。初回起動時は存在せず /pomo init 実行時に生成される。
 * adminRoleName は基準となる実行権限ロール名 (既定 'pomo-admin'、常に許可)。
 * adminRoleNames は /pomo admin-role で追加した許可ロール名の一覧 (既定 [])。
 * いずれかのロールを持つメンバーが /pomo 系コマンドを実行できる。
 */
export const BotConfigSchema = z.object({
  default: TimerConfigSchema,
  guildId: z.string().min(1),
  voiceChannelId: z.string().min(1),
  adminRoleName: z.string().min(1).default('pomo-admin'),
  adminRoleNames: z.array(z.string().min(1)).default([]),
});
export type BotConfig = z.infer<typeof BotConfigSchema>;
