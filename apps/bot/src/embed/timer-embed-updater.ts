import type { BaseMessageOptions } from 'discord.js';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import { buildTimerEmbedContent } from './timer-embed.js';

export const TIMER_EMBED_UPDATE_INTERVAL_MS = 5_000;

/**
 * 5 の倍数秒境界より手前で発火させる安全マージン (ms)。
 *
 * setTimeout は OS タイマー精度 + Node.js イベントループ要因で常に正の方向に
 * ジッタを持つ (1〜数十 ms)。境界ちょうど (remaining = 55,000ms) を狙うと、
 * 実際の発火時刻には remaining = 54,9xx ms になっており Math.floor(54999/1000)=54
 * で 1 つ前の秒 ("00:54") が表示されてしまう。
 *
 * 50ms 手前で発火させると jitter ∈ [0, 50ms) の範囲は remaining ∈ [55,000, 55,050)
 * に収まり、Math.floor = 55 → "00:55" が安定して表示される。
 */
export const TIMER_EMBED_UPDATE_SAFETY_MARGIN_MS = 50;

/**
 * 残り ms から「次の更新を発火するまでの ms」を計算する純粋関数。
 * 詳細は TimerEmbedUpdater.start のコメント参照。テスト容易性のため export する。
 */
export function computeNextDelay(
  remainingMs: number,
  interval: number = TIMER_EMBED_UPDATE_INTERVAL_MS,
  margin: number = TIMER_EMBED_UPDATE_SAFETY_MARGIN_MS,
): number {
  // 「次の 5 の倍数秒境界までの ms」を 1..interval に正規化。
  // 例: remaining=59,200 → 4,200, remaining=55,000 → 5,000, remaining=55,001 → 1。
  const toBoundary = ((remainingMs - 1) % interval) + 1;
  const delay = toBoundary - margin;
  // 0 以下 = 境界に到達済み or 過ぎた直後。1 つ先の境界手前に飛ばす。
  // 例: remaining=55,030 (境界 55,000 を 30ms 過ぎた) → toBoundary=30, delay=-20 → +5000=4980
  if (delay <= 0) {
    return delay + interval;
  }
  return delay;
}

/** edit 可能なメッセージの最小インターフェース (実 Discord Message を US-10 で注入)。 */
export interface EditableMessage {
  edit(options: BaseMessageOptions): Promise<unknown>;
}

/** スナップショット供給元 (PomodoroTimer を US-10 で注入)。 */
export interface SnapshotSource {
  getSnapshot(): TimerSnapshot;
}

/**
 * タイマー用 Embed を 5秒ごとに edit 更新するドライバ (embed-spec §各フェーズ)。
 * work/break/finalBreak のみ更新し、countdown/ended/idle はスキップする
 * (countdown 突入後の 5秒更新停止 = ending-spec)。
 * 実 Discord Message / PomodoroTimer との配線は US-10 EmbedManager で行う。
 */
export class TimerEmbedUpdater {
  readonly #message: EditableMessage;
  readonly #source: SnapshotSource;
  readonly #config: BotConfig;
  readonly #onError: ((err: unknown) => void) | undefined;
  #interval: NodeJS.Timeout | null = null;

  constructor(
    message: EditableMessage,
    source: SnapshotSource,
    config: BotConfig,
    onError?: (err: unknown) => void,
  ) {
    this.#message = message;
    this.#source = source;
    this.#config = config;
    this.#onError = onError;
  }

  /**
   * 「次の 5 の倍数秒境界の少し手前 (= 残り秒の 1 の位が 0 / 5 になる瞬間より
   * SAFETY_MARGIN_MS だけ前)」まで setTimeout で待ってから update を発火し、
   * 同様のロジックで次回も再スケジュールする自己補正チェイン。
   *
   * setInterval を使わない理由: setInterval は再アームごとに微小ドリフトが
   * 蓄積し、25 分セッションでは累計数百ms ズレ得る。自己補正 setTimeout なら
   * 毎回 getSnapshot() で現在値を読み再計算するため、長時間でも境界に居続ける。
   *
   * 待ち時間計算の意図 (`#computeDelay`):
   * - ((remainingMs - 1) % INTERVAL) + 1 で「次の 5 の倍数秒境界までの ms」を
   *   1..INTERVAL に正規化 (境界ちょうどなら INTERVAL = 5000 を返す)。
   * - SAFETY_MARGIN_MS を引いて境界より少し手前で発火させる (Math.floor の
   *   切り捨てで 1 つ前の秒が表示されるのを防ぐ)。
   * - 引いた結果が 0 以下なら直前に発火済み (= 境界をジッタで超えた直後) なので
   *   INTERVAL ぶん足して次の境界手前に飛ばす。
   */
  start(): void {
    this.stop();
    this.#scheduleNext();
  }

  stop(): void {
    if (this.#interval !== null) {
      clearTimeout(this.#interval);
      this.#interval = null;
    }
  }

  #scheduleNext(): void {
    const snapshot = this.#source.getSnapshot();
    const delay = computeNextDelay(snapshot.remainingMs);
    this.#interval = setTimeout(() => {
      this.#update();
      this.#scheduleNext();
    }, delay);
  }

  #update(): void {
    const snapshot = this.#source.getSnapshot();
    if (
      snapshot.phase !== 'work' &&
      snapshot.phase !== 'break' &&
      snapshot.phase !== 'finalBreak'
    ) {
      return;
    }
    void this.#message
      .edit(buildTimerEmbedContent(snapshot, this.#config))
      .catch((err: unknown) => {
        if (this.#onError) {
          this.#onError(err);
        }
      });
  }
}
