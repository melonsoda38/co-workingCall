import {
  AttachmentBuilder,
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

/** Discord field の name 非表示化に使う zero-width space。 */
const ZWSP = '​';

/**
 * Embed 本文と添付画像 (新規投稿・edit 共通の中身)。
 * レイアウト (embed-spec §2):
 * - title: "🍅 ポモドーロタイマー" (固定)
 * - color: フェーズ別 (左バー。phaseColorHex を 16進→数値化)
 * - image: 円形タイマー画像 (中央に残り分/フェーズ/セット、外周に進捗リング)。
 *   時刻・フェーズ・セットは全て画像に集約 (text field では出さない)。
 * - 設定サマリ field (inline: false): "作業X分 / 休憩Y分 / Mセット / 最終休憩Z分"
 *
 * 画像は分刻み更新前提 (TimerEmbedUpdater の間隔 60 秒)。
 */
export function buildTimerEmbedContent(
  snapshot: TimerSnapshot,
  config: BotConfig,
): BaseMessageOptions {
  const png = renderTimerImage(snapshot, config);
  const attachment = new AttachmentBuilder(png, { name: TIMER_IMAGE_NAME });

  const embed = new EmbedBuilder()
    .setTitle('🍅 ポモドーロタイマー')
    .setColor(Number.parseInt(phaseColorHex(snapshot.phase).slice(1), 16))
    .setImage(`attachment://${TIMER_IMAGE_NAME}`)
    .addFields({ name: ZWSP, value: formatConfigSummary(config), inline: false });

  // 作業中タイマー Embed にはボタンを置かない (設定アイコンは廃止)。
  return { embeds: [embed], files: [attachment] };
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
