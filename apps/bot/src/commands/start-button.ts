import { ButtonInteraction, MessageFlags } from 'discord.js';
import type { Logger } from 'pino';
import { loadConfig } from '../config/index.js';
import type { VoiceSession } from '../voice/session-registry.js';
import { scheduleEphemeralAutoDelete } from './ephemeral.js';

/** 実行者が対象 VC にいるかの純判定 (commands-spec: ▶開始の前提条件)。 */
export function isExecutorInTargetVc(
  memberVoiceChannelId: string | null | undefined,
  targetVcId: string,
): boolean {
  return memberVoiceChannelId === targetVcId;
}

/**
 * ▶ タイマー開始ボタン (pomo_start) 押下処理。commands-spec のフローに準拠。
 * 実行者 VC チェック → bot 入室保証 → config.json 最新値で timer.start。
 * timer.start が phaseChange(work) を発火し、EmbedManager がスタート Embed 削除 →
 * タイマー Embed 投稿を自動で行う。session が無い (config 未確定) 場合は ephemeral 応答。
 */
export async function handleStartButton(
  interaction: ButtonInteraction,
  session: VoiceSession | undefined,
  configPath: string,
  logger: Logger,
): Promise<void> {
  // 早期 return 系の ephemeral reply 用ヘルパ (各 reply 後の自動削除スケジュール込み)。
  // 成功パス末尾の deferUpdate は元 Embed の更新用なので scheduleEphemeralAutoDelete は呼ばない
  // (deleteReply するとボタン押下対象のスタート Embed が消える)。
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

    const member = await guild.members.fetch(interaction.user.id);
    if (!isExecutorInTargetVc(member.voice.channelId, session.config.voiceChannelId)) {
      await replyEphemeral('VCに参加してから押してください');
      return;
    }

    // 終了演出フロー進行中は phase が経路で異なる (自然 ended='ended' / 空VC経由='idle')
    // ため、phase だけでなく isEnding も見て一貫して弾く。
    if (session.timer.getSnapshot().phase !== 'idle' || session.embedManager.isEnding) {
      await replyEphemeral('すでにタイマーが動作中です');
      return;
    }

    // bot がまだ VC にいなければ入室する (通常は自動入室済み)。
    const connected = await session.voiceManager.ensureConnected();
    if (!connected) {
      await replyEphemeral('botがVCに接続できませんでした。少し待って再度お試しください');
      return;
    }

    // config.json の最新値を反映 (設定モーダルの変更を再起動なしで反映)。
    const loaded = await loadConfig(configPath);
    const config = loaded.status === 'ok' ? loaded.config : session.config;
    session.embedManager.applyConfig(config);
    // 押下されたスタート Embed を削除対象に取り込み、ボタンを ack する。
    session.embedManager.adoptStartEmbed(interaction.message.id);
    await interaction.deferUpdate();

    // タイマー開始。phaseChange(work) で EmbedManager がスタート削除 & タイマー投稿。
    session.timer.start(config.default);
    logger.info({ guildId: guild.id, default: config.default }, '▶ タイマー開始');
  } catch (err) {
    logger.error({ err }, '▶ タイマー開始処理に失敗しました');
    if (!interaction.replied && !interaction.deferred) {
      try {
        await replyEphemeral('タイマー開始に失敗しました。ログを確認してください');
      } catch (replyErr) {
        logger.error({ err: replyErr }, 'エラー応答にも失敗しました');
      }
    }
  }
}
