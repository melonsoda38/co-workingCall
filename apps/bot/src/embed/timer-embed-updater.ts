import type { BaseMessageOptions } from 'discord.js';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import { buildTimerEmbedContent } from './timer-embed.js';

export const TIMER_EMBED_UPDATE_INTERVAL_MS = 5_000;

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
   * 「次の 5 の倍数秒境界 (残り秒の 1 の位が 0 / 5)」まで setTimeout で待ってから
   * 初回 update を発火し、以降は setInterval(5_000ms) で厳密に 5 秒ごとに更新する。
   *
   * これをやらないと post の API 往復遅延 (数百ms〜2s) がそのまま 5 秒インターバルの
   * フェイズになり、"59→54→49" のような半端な数字が並ぶ。
   *
   * 待ち時間の計算 ((remainingMs - 1) % INTERVAL) + 1 の意図:
   * - 範囲を 1..INTERVAL に正規化する (0 は不採用)
   * - remainingMs が境界ちょうど (例 55,000ms) のとき即時 update は冗長なので
   *   INTERVAL ぶん待たせる (5,000ms 後の "00:50" まで)
   * - 例: 残り 59,200ms → 4,200ms 待ち → "00:55" 表示
   * - 例: 残り 55,000ms → 5,000ms 待ち → "00:50" 表示
   * - 例: 残り    500ms →   500ms 待ち → "00:00" 表示
   */
  start(): void {
    this.stop();
    const snapshot = this.#source.getSnapshot();
    const initialDelay = ((snapshot.remainingMs - 1) % TIMER_EMBED_UPDATE_INTERVAL_MS) + 1;
    this.#interval = setTimeout(() => {
      this.#update();
      // 1 回目以降は厳密に 5,000ms 間隔で発火 (境界に揃ったままドリフトしない)。
      this.#interval = setInterval(() => {
        this.#update();
      }, TIMER_EMBED_UPDATE_INTERVAL_MS);
    }, initialDelay);
  }

  stop(): void {
    if (this.#interval !== null) {
      // Node.js では clearTimeout / clearInterval は同一の Timeout 型を受け取れるため、
      // setTimeout 状態 (初回境界待ち) / setInterval 状態 (定常) どちらも clearInterval で消せる。
      clearInterval(this.#interval);
      this.#interval = null;
    }
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
