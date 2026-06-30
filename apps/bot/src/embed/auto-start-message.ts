import type { MessageCreateOptions } from 'discord.js';

/**
 * 自動スタート時刻に既存セッションをリセットして自動スタートを優先する場合、
 * リセット前に投稿するお知らせ。label ("xx") は /pomo auto-label で設定する文字列。
 * 通知を鳴らすため SuppressNotifications は付けない。プレーンテキストなので
 * purgeOwnEmbeds (Embed 付き対象) では消えず、区切りとしてテキスト欄に残る。
 */
export function buildAutoStartResetMessage(label: string): MessageCreateOptions {
  return {
    content: `失礼します。${label}の時間になりましたのでタイマーをリセットしてから${label}を開始します`,
  };
}
