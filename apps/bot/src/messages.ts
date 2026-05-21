import { MessageFlags, type MessageCreateOptions } from 'discord.js';

/** bot 自動入室時に VC 内蔵テキスト欄へ送る入室メッセージ (voice-spec)。 */
export const ENTRY_MESSAGE = 'こんにちは 👋';

/** 入室メッセージの送信オプション。通知を抑制して静かに投稿する (voice-spec)。 */
export function buildEntryMessageOptions(): MessageCreateOptions {
  return { content: ENTRY_MESSAGE, flags: MessageFlags.SuppressNotifications };
}
