import type { Logger } from 'pino';

/**
 * VCテキスト欄から bot 自身が投稿した Embed 付きメッセージを掃除する。
 * 新しい Embed を投稿する直前に呼び出し、テキスト欄に Embed が複数残る事故
 * (bot 異常終了による追跡漏れ、/pomo init 連打、旧VC残骸など) を防ぐ。
 *
 * 設計方針:
 * - best-effort。fetch/個別 delete の失敗は warn ログのみで投稿処理は止めない
 *   (掃除が失敗してもメインの Embed 投稿は完遂させる)。
 * - 対象は「bot 自身が投稿した・Embed を含む」メッセージのみ。
 *   他 bot や人間のメッセージ、Embed なしの bot メッセージ (ephemeral 等) は触らない。
 * - fetch 上限 100 件 (Discord API の単発上限)。これで足りない極端な状況は
 *   そもそも運用異常なので別途対応とする。
 */
/** purgeOwnEmbeds が必要とするメッセージの最小形状 (discord.js Message 互換)。 */
export interface PurgeMessage {
  id: string;
  author: { id: string };
  embeds: readonly unknown[];
  delete(): Promise<unknown>;
}

/** purgeOwnEmbeds が必要とするチャンネルの最小形状。 */
export interface PurgeableChannel {
  messages: {
    fetch(options: { limit: number }): Promise<{
      filter(fn: (m: PurgeMessage) => boolean): { values(): IterableIterator<PurgeMessage> };
    }>;
  };
}

export async function purgeOwnEmbeds(
  channel: PurgeableChannel,
  clientUserId: string,
  logger: Logger,
): Promise<void> {
  let collected: { values(): IterableIterator<PurgeMessage> };
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    collected = messages.filter((m) => m.author.id === clientUserId && m.embeds.length > 0);
  } catch (err) {
    logger.warn({ err }, 'VCテキスト欄のメッセージ取得に失敗 (Embed掃除をスキップ)');
    return;
  }
  for (const msg of collected.values()) {
    try {
      await msg.delete();
    } catch (err) {
      logger.warn({ err, messageId: msg.id }, '過去のEmbed削除に失敗 (best-effort)');
    }
  }
}
