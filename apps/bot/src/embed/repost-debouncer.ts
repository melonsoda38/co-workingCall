export const DEFAULT_DEBOUNCE_MS = 60_000;
export const DEFAULT_MAX_WAIT_MS = 180_000;

export interface RepostDebouncerOptions {
  /** 発火時に実行する処理 (旧Embed削除→新Embed投稿。US-10 で注入)。 */
  callback: () => Promise<void> | void;
  /** デバウンス時間 (既定 60秒)。 */
  debounceMs?: number;
  /** 最大待機時間 (既定 180秒、firstTriggerAt 起算)。 */
  maxWaitMs?: number;
  /** callback 失敗時の通知 (US-10 で pino に接続)。 */
  onError?: (err: unknown) => void;
}

/**
 * embed-spec §自動削除&再投稿 のデバウンス + maxWait ロジック (Discord 非依存)。
 * setTimeout / clearTimeout のみ使用 (setInterval 禁止 = spec)。
 * debounce 60秒 OR maxWait 180秒 のいずれかで callback を実行する。
 * callback 実行中の trigger は完了後に新サイクルで集約処理する。
 */
export class RepostDebouncer {
  readonly #callback: () => Promise<void> | void;
  readonly #debounceMs: number;
  readonly #maxWaitMs: number;
  readonly #onError: ((err: unknown) => void) | undefined;
  #debounceTimer: NodeJS.Timeout | null = null;
  #maxWaitTimer: NodeJS.Timeout | null = null;
  #firstTriggerAt: number | null = null;
  #isReposting = false;
  #pendingRetrigger = false;

  constructor(options: RepostDebouncerOptions) {
    this.#callback = options.callback;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.#onError = options.onError;
  }

  /** callback 実行中かどうか。 */
  get isReposting(): boolean {
    return this.#isReposting;
  }

  /** バースト開始時刻 (未起動なら null)。 */
  get firstTriggerAt(): number | null {
    return this.#firstTriggerAt;
  }

  /** 人間メッセージ検知時に呼ぶ。 */
  trigger(): void {
    if (this.#isReposting) {
      // 実行中の trigger は完了後の次サイクルで集約処理する。
      this.#pendingRetrigger = true;
      return;
    }
    if (this.#maxWaitTimer === null) {
      this.#firstTriggerAt = Date.now();
      this.#maxWaitTimer = setTimeout(() => {
        void this.#flush();
      }, this.#maxWaitMs);
    }
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
    }
    this.#debounceTimer = setTimeout(() => {
      void this.#flush();
    }, this.#debounceMs);
  }

  /** タイマー類を全クリア (フェーズ切替/countdown/ended/VC退出時)。 */
  cancel(): void {
    this.#clearTimers();
    this.#pendingRetrigger = false;
  }

  #clearTimers(): void {
    if (this.#debounceTimer !== null) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    if (this.#maxWaitTimer !== null) {
      clearTimeout(this.#maxWaitTimer);
      this.#maxWaitTimer = null;
    }
    this.#firstTriggerAt = null;
  }

  async #flush(): Promise<void> {
    this.#clearTimers();
    this.#isReposting = true;
    try {
      await Promise.resolve(this.#callback());
    } catch (err) {
      if (this.#onError) {
        this.#onError(err);
      }
    } finally {
      this.#isReposting = false;
    }
    if (this.#pendingRetrigger) {
      this.#pendingRetrigger = false;
      this.trigger();
    }
  }
}
