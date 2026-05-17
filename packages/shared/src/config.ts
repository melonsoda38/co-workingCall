import { z } from 'zod';
import { TimerConfigSchema } from './timer.js';

/**
 * 永続化設定 (config.json)。初回起動時は存在せず /pomo init 実行時に生成される。
 * adminRoleName は /pomo init の実行権限ロール名 (既定 'pomo-admin')。
 */
export const BotConfigSchema = z.object({
  default: TimerConfigSchema,
  guildId: z.string().min(1),
  voiceChannelId: z.string().min(1),
  adminRoleName: z.string().min(1).default('pomo-admin'),
});
export type BotConfig = z.infer<typeof BotConfigSchema>;
