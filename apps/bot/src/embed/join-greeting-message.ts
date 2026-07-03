import { MessageFlags, type MessageCreateOptions } from 'discord.js';

/**
 * VC 入室時の挨拶投稿。bot 在室中に人間ユーザーが対象 VC へ入ってきたときに
 * 「{表示名}さんよろしくおねがいします！」を投稿する。Embed なしのプレーンテキストで、
 * SuppressNotifications を付けて通知音は鳴らさない (サイレント投稿)。
 * 入室のたびに投稿する一過性メッセージで、ID 追跡・削除はしない。
 */
export function buildJoinGreetingMessage(displayName: string): MessageCreateOptions {
  return {
    content: `${displayName}さんよろしくおねがいします！`,
    flags: MessageFlags.SuppressNotifications,
  };
}
