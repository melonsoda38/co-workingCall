import type { Logger } from 'pino';

/**
 * ephemeral 応答を自動削除するまでの時間 (14 分)。
 *
 * Discord の interaction token は約 15 分で expire し、token 期限切れ後の
 * deleteReply は 401/404 で失敗する。よって 6 時間など長い時間では実質
 * 削除されない (catch で握りつぶされるだけ)。token 期限内 (15分未満) かつ
 * ユーザーが内容を読むのに十分な時間として 14 分を採用。
 */
export const EPHEMERAL_AUTO_DELETE_MS = 14 * 60 * 1000;

/** scheduleEphemeralAutoDelete が必要とする最小インタフェース。 */
export interface AutoDeletableInteraction {
  deleteReply(): Promise<unknown>;
  /** deferReply 済みか (ephemeral 応答が成立している指標)。 */
  deferred: boolean;
  /** reply 済みか (同上)。 */
  replied: boolean;
}

/**
 * ephemeral 応答を指定時間後に自動削除する setTimeout をスケジュールする (同期、即返却)。
 * Discord の ephemeral はクライアント更新まで残るため、bot 側で明示的に deleteReply
 * して跡を残さない。
 *
 * 設計上の許容:
 * - 応答していない (deferred/replied 双方 false) ならスケジュールしない (no-op)
 * - bot 再起動で setTimeout は失われる → クリーンアップ漏れは Discord 側のクライアント更新時消去にフォールバック
 * - deleteReply が reject (既に削除済み・interaction token expired 等) しても例外は伝播させず debug ログのみ
 * - setTimeout は unref() でプロセス終了を妨げない (テスト時の hang 防止)
 *
 * 注意: delayMs は interaction token の有効期限 (約 15 分) 未満であること。
 * 15 分を超える値を指定すると token expired で deleteReply が失敗し実質削除されない。
 */
export function scheduleEphemeralAutoDelete(
  interaction: AutoDeletableInteraction,
  logger: Logger,
  delayMs: number = EPHEMERAL_AUTO_DELETE_MS,
): void {
  if (!interaction.deferred && !interaction.replied) {
    return;
  }
  const timer = setTimeout(() => {
    interaction.deleteReply().catch((err: unknown) => {
      logger.debug({ err }, 'ephemeral 応答の自動削除に失敗 (既に削除済み or interaction expired)');
    });
  }, delayMs);
  timer.unref();
}
