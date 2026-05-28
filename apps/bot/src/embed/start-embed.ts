import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type MessageCreateOptions,
} from 'discord.js';
import type { BotConfig } from '@co-working-call/shared';

export const START_BUTTON_ID = 'pomo_start';
export const SETTINGS_BUTTON_ID = 'pomo_settings_open';

/** 設定を embed-spec §1 の1行表記にする (例: 作業25分 / 休憩5分 / 4セット / 最終休憩15分)。 */
export function formatConfigSummary(config: BotConfig): string {
  const { workSec, breakSec, sets, finalBreakSec } = config.default;
  const min = (sec: number): string => String(Math.round(sec / 60));
  return `作業${min(workSec)}分 / 休憩${min(breakSec)}分 / ${String(sets)}セット / 最終休憩${min(finalBreakSec)}分`;
}

/**
 * 作業スタート用 Embed メッセージ (embed-spec §1)。
 * idle 状態で表示し、タイマー開始のトリガーになる。
 * ボタン押下処理は US-8 (開始) / US-12 (設定) で実装する。
 */
export function buildStartEmbedMessage(config: BotConfig): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle('Timer')
    .setDescription('ボタンを押して作業を始めましょう')
    .addFields({ name: '現在の設定', value: formatConfigSummary(config) });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(START_BUTTON_ID)
      .setStyle(ButtonStyle.Primary)
      .setLabel('タイマー開始')
      .setEmoji('▶️'),
    new ButtonBuilder()
      .setCustomId(SETTINGS_BUTTON_ID)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('⚙️'),
  );

  return {
    embeds: [embed],
    components: [row],
    flags: MessageFlags.SuppressNotifications,
  };
}
