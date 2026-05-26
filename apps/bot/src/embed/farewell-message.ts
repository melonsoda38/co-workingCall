import type { MessageCreateOptions } from 'discord.js';

/** お疲れさま投稿の文言 (ending-spec §第二段階)。 */
export const FAREWELL_CONTENT = 'お疲れさまでした 👋';

/**
 * 終了時の「お疲れさまでした」投稿。embed-spec §「終了時の唯一の例外」に従い
 * SuppressNotifications を**付けない** (ちゃんと通知音を鳴らす)。Embed なしの
 * プレーンテキストなので purgeOwnEmbeds の対象 (Embed 付きメッセージ) にもならず、
 * テキスト欄に区切りとして残る。
 */
export function buildFarewellMessage(): MessageCreateOptions {
  return { content: FAREWELL_CONTENT };
}
