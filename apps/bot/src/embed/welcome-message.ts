import type { MessageCreateOptions } from 'discord.js';

/** タイマー開始時の歓迎投稿の文言。 */
export const WELCOME_CONTENT =
  'ご参加ありがとうございます〜\n一緒に作業・勉強よろしくおねがいします。';

/**
 * タイマー開始時の歓迎投稿。farewell と同様に Embed なしのプレーンテキストで、
 * SuppressNotifications は付けない (参加者に通知する)。Embed ではないため
 * purgeOwnEmbeds の対象外。EmbedManager 側で id を追跡し、終了演出 / onIdle で
 * 明示的に delete する。
 */
export function buildWelcomeMessage(): MessageCreateOptions {
  return { content: WELCOME_CONTENT };
}
