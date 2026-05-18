import {
  ChannelType,
  ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import { loadConfig, saveConfig } from '../config/index.js';
import { buildStartEmbedMessage } from '../embed/index.js';
import { hasAdminRole, missingBotPermissions } from './checks.js';

/** config 未存在時の初期タイマー設定 (commands-spec モーダル placeholder: 25/5/4/15 分)。 */
const DEFAULT_TIMER: BotConfig['default'] = {
  workSec: 25 * 60,
  breakSec: 5 * 60,
  sets: 4,
  finalBreakSec: 15 * 60,
};

export const pomoCommand = new SlashCommandBuilder()
  .setName('pomo')
  .setDescription('ポモドーロ bot のセットアップ')
  .addSubcommand((sub) =>
    sub.setName('init').setDescription('このボイスチャンネルでセットアップ/復旧する'),
  );

/**
 * /pomo init ハンドラ。commands-spec.md のフローに準拠。
 * すべてのエラー応答は ephemeral。例外は内部で処理し reject しない。
 */
export async function handlePomoInit(
  interaction: ChatInputCommandInteraction,
  configPath: string,
  logger: Logger,
): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = interaction.channel;
    if (channel?.type !== ChannelType.GuildVoice) {
      await interaction.editReply('このコマンドはボイスチャンネル内のテキスト欄で実行してください');
      return;
    }
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply('セットアップに失敗しました。ログを確認してください');
      return;
    }

    const existing = await loadConfig(configPath);
    const existingConfig = existing.status === 'ok' ? existing.config : null;
    const adminRoleName = existingConfig?.adminRoleName ?? 'pomo-admin';

    const member = await guild.members.fetch(interaction.user.id);
    const roleNames = member.roles.cache.map((role) => role.name);
    if (!hasAdminRole(roleNames, adminRoleName)) {
      await interaction.editReply(`このコマンドの実行には ${adminRoleName} ロールが必要です`);
      return;
    }

    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms || missingBotPermissions(perms).length > 0) {
      const missing = perms ? missingBotPermissions(perms) : ['(権限取得不可)'];
      logger.warn({ missing, channelId: channel.id }, 'bot の VC 権限が不足しています');
      await interaction.editReply(
        'botがこのVCにアクセスする権限がありません。管理者に確認してください',
      );
      return;
    }

    // 旧 VC のスタート Embed 削除は best-effort。
    // Embed メッセージ追跡は US-10 (EmbedManager) で実装するため現状はログのみ。
    if (existingConfig && existingConfig.voiceChannelId !== channel.id) {
      logger.info(
        { oldVoiceChannelId: existingConfig.voiceChannelId, newVoiceChannelId: channel.id },
        '旧VCのスタートEmbed削除は US-10 で対応 (現状スキップ)',
      );
    }

    const config: BotConfig = {
      default: existingConfig?.default ?? DEFAULT_TIMER,
      guildId: guild.id,
      voiceChannelId: channel.id,
      adminRoleName,
    };
    await saveConfig(configPath, config);
    await channel.send(buildStartEmbedMessage(config));

    await interaction.editReply('セットアップ完了しました');
    logger.info({ guildId: guild.id, voiceChannelId: channel.id }, '/pomo init 完了');
  } catch (err) {
    logger.error({ err }, '/pomo init 処理に失敗しました');
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('セットアップに失敗しました。ログを確認してください');
      } else {
        await interaction.reply({
          content: 'セットアップに失敗しました。ログを確認してください',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyErr) {
      logger.error({ err: replyErr }, 'エラー応答にも失敗しました');
    }
  }
}
