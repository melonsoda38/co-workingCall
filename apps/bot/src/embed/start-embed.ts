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

/**
 * 作業スタート用 Embed メッセージ (US-6 最小実装)。
 * 見た目の作り込みは US-7、ボタン押下処理は US-7 以降で実装する。
 * commands-spec.md の custom_id / 絵文字に準拠。
 */
export function buildStartEmbedMessage(config: BotConfig): MessageCreateOptions {
  const { workSec, breakSec, sets, finalBreakSec } = config.default;

  const embed = new EmbedBuilder()
    .setTitle('🍅 ポモドーロタイマー')
    .setDescription('「タイマー開始」ボタンで作業を始めます。')
    .addFields(
      { name: '作業', value: `${String(workSec / 60)}分`, inline: true },
      { name: '休憩', value: `${String(breakSec / 60)}分`, inline: true },
      { name: 'セット数', value: String(sets), inline: true },
      { name: '最終休憩', value: `${String(finalBreakSec / 60)}分`, inline: true },
    );

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
