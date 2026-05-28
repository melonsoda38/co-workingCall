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
/** purge 系が必要とするメッセージの最小形状 (discord.js Message 互換)。 */
export interface PurgeMessage {
  id: string;
  author: { id: string };
  embeds: readonly unknown[];
  content: string;
  delete(): Promise<unknown>;
}

/** purge 系が必要とするチャンネルの最小形状。 */
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

/**
 * VCテキスト欄から bot 自身が投稿した「特定本文のプレーンテキスト」を掃除する。
 * 歓迎 / お疲れさま投稿は Embed なしで purgeOwnEmbeds の対象外。これらは通常 id 追跡で
 * 削除するが、bot 異常終了・再起動で id 追跡を失うと孤児として残る。本文 (content) 完全
 * 一致 + 自分の投稿のみを対象にして、新セッション開始時・idle 復帰時・起動時に掃除する。
 *
 * 本文一致のため、人間が同じ文言を投稿しても author.id が異なるので消さない。best-effort。
 */
export async function purgeOwnTexts(
  channel: PurgeableChannel,
  clientUserId: string,
  contents: readonly string[],
  logger: Logger,
): Promise<void> {
  const targets = new Set(contents);
  let collected: { values(): IterableIterator<PurgeMessage> };
  try {
    const messages = await channel.messages.fetch({ limit: 100 });
    collected = messages.filter((m) => m.author.id === clientUserId && targets.has(m.content));
  } catch (err) {
    logger.warn({ err }, 'VCテキスト欄のメッセージ取得に失敗 (テキスト掃除をスキップ)');
    return;
  }
  for (const msg of collected.values()) {
    try {
      await msg.delete();
    } catch (err) {
      logger.warn({ err, messageId: msg.id }, '過去のテキスト削除に失敗 (best-effort)');
    }
  }
}
