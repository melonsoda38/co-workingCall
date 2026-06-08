import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type BaseMessageOptions,
  type MessageCreateOptions,
} from 'discord.js';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import { formatConfigSummary } from './start-embed.js';
import { phaseColorHex, renderTimerImage } from './timer-image.js';

/** タイマー画像の添付ファイル名 (Embed から attachment:// で参照する)。 */
export const TIMER_IMAGE_NAME = 'timer.png';

/** 「続行」ボタンの customId (最終休憩 Embed に表示。US-続行)。 */
export const CONTINUE_BUTTON_ID = 'pomo_continue';

/** 最終休憩 Embed の footer に設定サマリへ続けて表示する続行案内テキスト。 */
export const CONTINUE_PROMPT_TEXT = '続ける場合:';

/** 「続行」ボタン 1 個だけを持つ ActionRow (最終休憩時のみ付与)。 */
function buildContinueRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(CONTINUE_BUTTON_ID)
      .setStyle(ButtonStyle.Success)
      .setLabel('続行'),
  );
}

/**
 * Embed 本文と添付画像 (新規投稿・edit 共通の中身)。
 * レイアウト (embed-spec §2):
 * - title: "Timer" (固定。直下に余白は入れない)
 * - color: フェーズ別 (左バー。phaseColorHex を 16進→数値化)
 * - image: 円形タイマー画像 (中央に残り分/フェーズ/セット、外周に進捗リング)。
 *   時刻・フェーズ・セットは全て画像に集約 (text field では出さない)。
 * - footer: 設定サマリ "作業X分 / 休憩Y分 / Mセット / 最終休憩Z分" (画像の下に描画)。
 *   最終休憩フェーズのみ footer 末尾に "続ける場合:" を足し、Embed 下に「続行」ボタンを付ける。
 *
 * 画像は分刻み更新前提 (TimerEmbedUpdater の間隔 60 秒)。
 *
 * components は **常に明示的に返す** (最終休憩=続行ボタン / それ以外=空配列)。これにより
 * フェーズをまたいで edit された場合でもボタンの付け外しが確実に反映される。
 */
export function buildTimerEmbedContent(
  snapshot: TimerSnapshot,
  config: BotConfig,
): BaseMessageOptions {
  const png = renderTimerImage(snapshot, config);
  const attachment = new AttachmentBuilder(png, { name: TIMER_IMAGE_NAME });

  const isFinalBreak = snapshot.phase === 'finalBreak';
  const footerText = isFinalBreak
    ? `${formatConfigSummary(config)}\n${CONTINUE_PROMPT_TEXT}`
    : formatConfigSummary(config);

  const embed = new EmbedBuilder()
    .setTitle('Timer')
    .setColor(Number.parseInt(phaseColorHex(snapshot.phase).slice(1), 16))
    .setImage(`attachment://${TIMER_IMAGE_NAME}`)
    .setFooter({ text: footerText });

  return {
    embeds: [embed],
    files: [attachment],
    components: isFinalBreak ? [buildContinueRow()] : [],
  };
}

/** 作業中タイマー用 Embed メッセージ (新規投稿用。SuppressNotifications 付き)。 */
export function buildTimerEmbedMessage(
  snapshot: TimerSnapshot,
  config: BotConfig,
): MessageCreateOptions {
  return {
    ...buildTimerEmbedContent(snapshot, config),
    flags: MessageFlags.SuppressNotifications,
  };
}
