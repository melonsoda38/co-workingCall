import { MessageFlags, type MessageCreateOptions } from 'discord.js';

/** タイマー開始時の歓迎投稿の文言。 */
export const WELCOME_CONTENT =
  'ご参加ありがとうございます〜\n一緒に作業・勉強よろしくおねがいします。';

/**
 * タイマー開始時の歓迎投稿。Embed なしのプレーンテキストで、
 * SuppressNotifications を付けて通知音を鳴らさない (サイレント投稿)。Embed ではないため
 * purgeOwnEmbeds の対象外。EmbedManager 側で id を追跡し、終了演出 / onIdle で
 * 明示的に delete する。
 */
export function buildWelcomeMessage(): MessageCreateOptions {
  return { content: WELCOME_CONTENT, flags: MessageFlags.SuppressNotifications };
}
