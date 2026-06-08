import type { MessageCreateOptions } from 'discord.js';

/**
 * 23時間キャップによる強制終了時の投稿文言 (US-続行)。
 * 「続行」でタイマーが翌日まで続き新セッションを開始できなくなるのを防ぐため、
 * セッション開始から23時間後に強制終了した際にこの旨を投稿する。
 */
export const TIMEOUT_CONTENT =
  '次の作業通話のため、23時間でタイマーを自動終了しました。\nまたご利用ください 👋';

/**
 * 23時間キャップ終了の投稿。farewell と同様に Embed なしのプレーンテキストで、
 * SuppressNotifications は付けない (参加者に通知する)。purgeOwnEmbeds の対象外のため
 * EmbedManager 側で本文一致掃除 (purgeOwnTexts) の対象にも含める。
 */
export function buildTimeoutMessage(): MessageCreateOptions {
  return { content: TIMEOUT_CONTENT };
}
