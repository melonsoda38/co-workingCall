/**
 * 終了演出のフォローアップ (お疲れさま削除 → 新スタート Embed 投稿) を遅延実行する予約管理。
 * EmbedManager から setTimeout 管理だけを切り出したもの。run の中身 (Discord 操作) は
 * EmbedManager 側コールバックに委ねる。挙動は EmbedManager 内蔵時と同一。
 */
export class EndingFollowupScheduler {
  #timer: NodeJS.Timeout | null = null;
  readonly #delayMs: number;

  /** @param delayMs お疲れさま投稿からフォローアップまでの遅延 (15秒)。 */
  constructor(delayMs: number) {
    this.#delayMs = delayMs;
  }

  /**
   * フォローアップを delayMs 後に一度だけ予約する。既存予約は破棄して上書きする
   * (二重 ended は #isEnding で防止済みだが念のため)。
   */
  schedule(run: () => void): void {
    this.cancel();
    this.#timer = setTimeout(() => {
      this.#timer = null;
      run();
    }, this.#delayMs);
  }

  /** 予約済みのフォローアップを解除する (新セッション開始 / idle 復帰時)。 */
  cancel(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
