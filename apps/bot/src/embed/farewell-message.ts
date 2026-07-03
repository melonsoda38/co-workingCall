import { MessageFlags, type MessageCreateOptions } from 'discord.js';

/** お疲れさま投稿の文言 (ending-spec §第二段階)。 */
export const FAREWELL_CONTENT = 'お疲れさまでした 👋';

/**
 * 終了時の「お疲れさまでした」投稿。SuppressNotifications を付けて通知音を鳴らさない
 * (サイレント投稿)。Embed なしのプレーンテキストなので purgeOwnEmbeds の対象
 * (Embed 付きメッセージ) にもならず、テキスト欄に区切りとして残る。
 * NOTE: embed-spec / ending-spec には「終了時は通知音を鳴らす例外」とあるが、
 * 運用要望で通知音は常に OFF に変更した。将来ドキュメントも合わせること。
 */
export function buildFarewellMessage(): MessageCreateOptions {
  return { content: FAREWELL_CONTENT, flags: MessageFlags.SuppressNotifications };
}
