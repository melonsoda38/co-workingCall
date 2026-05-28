import type { BaseMessageOptions } from 'discord.js';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import { buildTimerEmbedContent } from './timer-embed.js';

/**
 * タイマー画像の更新間隔 (ms)。分刻み表示なので 60 秒。
 *
 * タイマー Embed は円形画像 (中央に残り分) で、表示が分単位でしか変わらない。
 * よって 5 秒ごとの更新は無駄 (帯域・CPU・画像再 fetch) なので分境界に合わせる。
 */
export const TIMER_EMBED_UPDATE_INTERVAL_MS = 60_000;

/**
 * 分境界より手前で発火させる安全マージン (ms)。
 *
 * setTimeout は OS タイマー精度 + Node.js イベントループ要因で常に正の方向に
 * ジッタを持つ (1〜数十 ms)。境界ちょうど (remaining = 24分=1,440,000ms) を狙うと、
 * 実際の発火時刻には remaining = 1,439,9xx ms になり ceil(残り/60000) が 1 分多く
 * 表示されるなど境界がズレる。手前で発火させて境界の内側で確実に更新する。
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
  // 「次の interval 境界 (分境界) までの ms」を 1..interval に正規化。
  // 例(interval=60,000): remaining=1,500,000 → 60,000, remaining=1,499,200 → 59,200。
  const toBoundary = ((remainingMs - 1) % interval) + 1;
  const delay = toBoundary - margin;
  // 0 以下 = 境界に到達済み or 過ぎた直後。1 つ先の境界手前に飛ばす。
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
 * タイマー用 Embed (円形画像) を分刻みで edit 更新するドライバ (embed-spec §各フェーズ)。
 * work/break/finalBreak のみ更新し、countdown/ended/idle はスキップする
 * (countdown 突入後の定期更新停止 = ending-spec)。
 * 実 Discord Message / PomodoroTimer との配線は EmbedManager で行う。
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
   * 「次の分境界の少し手前 (SAFETY_MARGIN_MS だけ前)」まで setTimeout で待ってから
   * update を発火し、同様のロジックで次回も再スケジュールする自己補正チェイン。
   *
   * setInterval を使わない理由: setInterval は再アームごとに微小ドリフトが蓄積し、
   * 長時間セッションでは累計でズレ得る。自己補正 setTimeout なら毎回 getSnapshot()
   * で現在値を読み再計算するため、長時間でも分境界に居続ける。
   *
   * 待ち時間計算は computeNextDelay 参照 (分境界の手前で発火させ、残り分表示の
   * 切り替わりタイミングに合わせる)。
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
