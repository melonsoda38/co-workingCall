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
import type { VoiceSession } from '../voice/session-registry.js';
import { hasAdminRole, isVoiceTextContext, missingBotPermissions } from './checks.js';

/** config 未存在時の初期タイマー設定 (commands-spec モーダル placeholder: 25/5/4/15 分)。 */
const DEFAULT_TIMER: BotConfig['default'] = {
  workSec: 25 * 60,
  breakSec: 5 * 60,
  sets: 4,
  finalBreakSec: 15 * 60,
};

/** VC 内蔵テキスト欄以外で /pomo 系コマンドを実行したときの共通エラー文言。 */
const VC_TEXT_ONLY_MESSAGE = 'このコマンドはボイスチャンネル内のテキスト欄で実行してください';

export const pomoCommand = new SlashCommandBuilder()
  .setName('pomo')
  .setDescription('ポモドーロ bot のセットアップ')
  .addSubcommand((sub) =>
    sub.setName('init').setDescription('このボイスチャンネルでセットアップ/復旧する'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('stop')
      .setDescription('タイマーを強制停止してスタート画面に戻す (設定は保持・テスト用)'),
  )
  .addSubcommand((sub) =>
    sub.setName('join').setDescription('bot を VC に再入室させる (タイマーは開始しない)'),
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
      await interaction.editReply(VC_TEXT_ONLY_MESSAGE);
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

/**
 * /pomo stop ハンドラ (テスト用)。タイマーを強制停止しスタート Embed に戻す。
 * タイマー設定 (config.json) はリセットしない。実行権限は pomo-admin ロール。
 * セッションは guildId で VoiceSessionRegistry から解決して渡す。
 */
export async function handlePomoStop(
  interaction: ChatInputCommandInteraction,
  session: VoiceSession | undefined,
  logger: Logger,
): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isVoiceTextContext(interaction.channel?.type)) {
      await interaction.editReply(VC_TEXT_ONLY_MESSAGE);
      return;
    }
    if (!session) {
      await interaction.editReply(
        'セットアップが必要です。/pomo init 実行後に bot を再起動してください',
      );
      return;
    }
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply('サーバー内で実行してください');
      return;
    }

    const member = await guild.members.fetch(interaction.user.id);
    const roleNames = member.roles.cache.map((role) => role.name);
    if (!hasAdminRole(roleNames, session.config.adminRoleName)) {
      await interaction.editReply(
        `このコマンドの実行には ${session.config.adminRoleName} ロールが必要です`,
      );
      return;
    }

    // 強制停止 → VC 退出 → スタート Embed 表示。設定は保持 (timer.stop は config.json を触らない)。
    session.timer.stop();
    session.voiceManager.forceDisconnect();
    await session.embedManager.onIdle();

    // 成功時は確認メッセージを出さない (結果はスタート Embed 再表示で分かる)。
    // 3 秒以内の応答義務を満たすため defer 済みの ephemeral 応答は削除する。
    await interaction.deleteReply();
    logger.info({ guildId: guild.id }, '/pomo stop 実行');
  } catch (err) {
    logger.error({ err }, '/pomo stop 処理に失敗しました');
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('停止処理に失敗しました。ログを確認してください');
      } else {
        await interaction.reply({
          content: '停止処理に失敗しました。ログを確認してください',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyErr) {
      logger.error({ err: replyErr }, 'エラー応答にも失敗しました');
    }
  }
}

/**
 * /pomo join ハンドラ。bot を対象 VC へ再入室させる (タイマーは開始しない)。
 * /pomo stop で退出させた後、VC に居たまま bot を呼び戻す用途。
 * 実行権限は pomo-admin ロール。セッションは VoiceSessionRegistry から解決して渡す。
 */
export async function handlePomoJoin(
  interaction: ChatInputCommandInteraction,
  session: VoiceSession | undefined,
  logger: Logger,
): Promise<void> {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isVoiceTextContext(interaction.channel?.type)) {
      await interaction.editReply(VC_TEXT_ONLY_MESSAGE);
      return;
    }
    if (!session) {
      await interaction.editReply(
        'セットアップが必要です。/pomo init 実行後に bot を再起動してください',
      );
      return;
    }
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply('サーバー内で実行してください');
      return;
    }

    const member = await guild.members.fetch(interaction.user.id);
    const roleNames = member.roles.cache.map((role) => role.name);
    if (!hasAdminRole(roleNames, session.config.adminRoleName)) {
      await interaction.editReply(
        `このコマンドの実行には ${session.config.adminRoleName} ロールが必要です`,
      );
      return;
    }

    // 既に VC に居る場合は何もしない (実行者にのみ ephemeral で通知)。
    if (session.voiceManager.connected) {
      await interaction.editReply('bot は既に VC に入室しています');
      return;
    }

    // 対象 VC へ再入室。タイマーには触れない。
    const connected = await session.voiceManager.ensureConnected();
    if (!connected) {
      await interaction.editReply('VCへの接続に失敗しました。ログを確認してください');
      return;
    }

    // 成功時は確認メッセージを出さない (bot が VC に現れることで分かる)。
    await interaction.deleteReply();
    logger.info({ guildId: guild.id }, '/pomo join 実行');
  } catch (err) {
    logger.error({ err }, '/pomo join 処理に失敗しました');
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('再入室処理に失敗しました。ログを確認してください');
      } else {
        await interaction.reply({
          content: '再入室処理に失敗しました。ログを確認してください',
          flags: MessageFlags.Ephemeral,
        });
      }
    } catch (replyErr) {
      logger.error({ err: replyErr }, 'エラー応答にも失敗しました');
    }
  }
}
