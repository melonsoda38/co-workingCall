import { ButtonInteraction, GuildMember, MessageFlags } from 'discord.js';
import type { Logger } from 'pino';
import type { VoiceSession } from '../voice/session-registry.js';
import { isExecutorInTargetVc } from './start-button.js';
import { scheduleEphemeralAutoDelete } from './ephemeral.js';

/**
 * 「続行」ボタン (pomo_continue) 押下処理 (US-続行)。
 * 最終休憩の Timer Embed に表示され、押したユーザは VC に残ってタイマーを継続できる。
 * ▶開始と違い管理ロール限定にはせず、対象 VC の参加者なら誰でも残る選択ができる
 * (続行は「自分が残るか」の個人選択のため)。
 *
 * 受理可否は EmbedManager.registerContinueUser に委ね、結果に応じて ephemeral で応答する。
 * Embed 自体は編集しない (ボタンはそのまま、他ユーザも引き続き押せる)。
 */
export async function handleContinueButton(
  interaction: ButtonInteraction,
  session: VoiceSession | undefined,
  logger: Logger,
): Promise<void> {
  const replyEphemeral = async (content: string): Promise<void> => {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    scheduleEphemeralAutoDelete(interaction, logger);
  };

  try {
    if (!session) {
      await replyEphemeral('セットアップが必要です。/pomo init 実行後に bot を再起動してください');
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await replyEphemeral('サーバー内で実行してください');
      return;
    }

    // ボタンが見えている最終休憩ギリギリの押下も ended に間に合わせたいので、可能な限り
    // 同期で処理して登録を急ぐ。interaction.member がキャッシュ済み GuildMember なら
    // guild.members.fetch の往復遅延を避けられる (US-続行 レース対策)。取得できない場合のみ
    // 従来どおり fetch にフォールバックする。
    const member =
      interaction.member instanceof GuildMember
        ? interaction.member
        : await guild.members.fetch(interaction.user.id);
    if (!isExecutorInTargetVc(member.voice.channelId, session.config.voiceChannelId)) {
      await replyEphemeral('VCに参加してから押してください');
      return;
    }

    const result = session.embedManager.registerContinueUser(member.id);
    if (result === 'ok') {
      await replyEphemeral('続行を受け付けました。このまま VC に残って作業を続けられます');
      logger.info({ guildId: guild.id, userId: member.id }, '続行ボタン受理');
    } else {
      await replyEphemeral('続行の受付は終了しました');
    }
  } catch (err) {
    logger.error({ err }, '続行ボタン処理に失敗しました');
    if (!interaction.replied && !interaction.deferred) {
      try {
        await replyEphemeral('続行の受付に失敗しました。ログを確認してください');
      } catch (replyErr) {
        logger.error({ err: replyErr }, 'エラー応答にも失敗しました');
      }
    }
  }
}
