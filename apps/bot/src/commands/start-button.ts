import { ButtonInteraction } from 'discord.js';
import type { Logger } from 'pino';
import { loadVcConfig } from '../config/index.js';
import type { VoiceSession } from '../voice/session-registry.js';
import { replyEphemeral } from './interaction-helpers.js';

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
  configDir: string,
  logger: Logger,
): Promise<void> {
  // 早期 return 系は replyEphemeral (reply + 自動削除スケジュール込み) を使う。
  // 成功パス末尾の deferUpdate は元 Embed の更新用なので自動削除は呼ばない
  // (deleteReply するとボタン押下対象のスタート Embed が消える)。
  try {
    if (!session) {
      await replyEphemeral(
        interaction,
        'セットアップが必要です。/pomo init 実行後に bot を再起動してください',
        logger,
      );
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await replyEphemeral(interaction, 'サーバー内で実行してください', logger);
      return;
    }

    const member = await guild.members.fetch(interaction.user.id);

    // タイマー開始は続行ボタンと同様、管理ロールに限定せず対象 VC の参加者なら誰でも押せる
    // (開始は「みんなで始める」個人選択のため)。ロールチェックは行わない。
    if (!isExecutorInTargetVc(member.voice.channelId, session.config.voiceChannelId)) {
      await replyEphemeral(interaction, 'VCに参加してから押してください', logger);
      return;
    }

    // 終了演出フロー進行中は phase が経路で異なる (自然 ended='ended' / 空VC経由='idle')
    // ため、phase だけでなく isEnding も見て一貫して弾く。
    if (session.timer.getSnapshot().phase !== 'idle' || session.embedManager.isEnding) {
      await replyEphemeral(interaction, 'すでにタイマーが動作中です', logger);
      return;
    }

    // bot がまだ VC にいなければ入室する (通常は自動入室済み)。
    const connected = await session.voiceManager.ensureConnected();
    if (!connected) {
      await replyEphemeral(
        interaction,
        'botがVCに接続できませんでした。少し待って再度お試しください',
        logger,
      );
      return;
    }

    // 当該 VC の config 最新値を反映 (設定モーダルの変更を再起動なしで反映)。
    const loaded = await loadVcConfig(
      configDir,
      session.config.guildId,
      session.config.voiceChannelId,
    );
    const config = loaded.status === 'ok' ? loaded.config : session.config;
    session.embedManager.applyConfig(config);
    // 音量設定 (音量モーダルの変更) もこのセッションから反映する。
    session.soundPlayer.setVolumes(config.volumes);
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
        await replyEphemeral(interaction, 'タイマー開始に失敗しました。ログを確認してください', logger);
      } catch (replyErr) {
        logger.error({ err: replyErr }, 'エラー応答にも失敗しました');
      }
    }
  }
}
