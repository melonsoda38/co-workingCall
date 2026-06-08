import type { Logger } from 'pino';

/**
 * VCテキスト欄から bot 自身が投稿した「カード系」メッセージを掃除する。
 * 新しいカードを投稿する直前に呼び出し、テキスト欄にカードが複数残る事故
 * (bot 異常終了による追跡漏れ、/pomo init 連打、旧VC残骸など) を防ぐ。
 *
 * 対象は「bot 自身が投稿した・Embed もしくはコンポーネント (ボタン/Components V2 Container)
 * を含む」メッセージ。スタート Embed・タイマー Embed (work/break) に加え、Components V2 で
 * 組む最終休憩/カウントダウンのタイマーカード (Embed を持たず Container のみ) も拾えるようにする。
 *
 * 設計方針:
 * - best-effort。fetch/個別 delete の失敗は warn ログのみで投稿処理は止めない。
 * - Embed もコンポーネントも無い bot メッセージ (歓迎/お疲れさまのプレーンテキスト等) は触らない。
 * - fetch 上限 100 件 (Discord API の単発上限)。これで足りない極端な状況は別途対応。
 */
/** purge 系が必要とするメッセージの最小形状 (discord.js Message 互換)。 */
export interface PurgeMessage {
  id: string;
  author: { id: string };
  embeds: readonly unknown[];
  /** 添付コンポーネント (ボタン行 / Components V2 Container)。V2 タイマーカードの検出に使う。 */
  components: readonly unknown[];
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
    // Embed 付き or コンポーネント付き (ボタン / V2 Container) の自分のメッセージを対象にする。
    collected = messages.filter(
      (m) => m.author.id === clientUserId && (m.embeds.length > 0 || m.components.length > 0),
    );
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
