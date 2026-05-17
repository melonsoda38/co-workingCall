import { EventEmitter } from 'node:events';
import type { TimerConfig, TimerPhase, TimerSnapshot } from '@co-working-call/shared';
import { TICK_MS, computePhase } from './phase.js';

/** PomodoroTimer が発火するイベントとそのペイロード。 */
export interface TimerEventMap {
  tick: [snapshot: TimerSnapshot];
  phaseChange: [snapshot: TimerSnapshot];
  countdown: [snapshot: TimerSnapshot];
  ended: [snapshot: TimerSnapshot];
  stopped: [snapshot: TimerSnapshot];
}

/**
 * Discord 非依存のポモドーロタイマー。
 * 時間の真実は常に Date.now() の差分で、setInterval は遷移検知用の定期チェック。
 * ended に達したら停止し phase='ended' を保持する (idle 復帰は reset() で行う)。
 */
export class PomodoroTimer extends EventEmitter {
  #config: TimerConfig | null = null;
  #startedAt: number | null = null;
  #totalSets = 0;
  #currentPhase: TimerPhase = 'idle';
  #interval: NodeJS.Timeout | null = null;

  /** タイマー開始。動作中なら一旦停止してから開始する。 */
  start(config: TimerConfig): void {
    this.#stopInterval();
    this.#config = config;
    this.#totalSets = config.sets;
    this.#startedAt = Date.now();
    this.#currentPhase = 'idle';
    // 初回 tick で idle → work(1) へ遷移させる。
    this.#tick();
    this.#interval = setInterval(() => {
      this.#tick();
    }, TICK_MS);
  }

  /** タイマーを停止し idle に戻す (手動停止)。 */
  stop(): void {
    const wasRunning = this.#startedAt !== null;
    this.#stopInterval();
    this.#config = null;
    this.#startedAt = null;
    this.#currentPhase = 'idle';
    if (wasRunning) {
      this.emit('stopped', this.getSnapshot());
    }
  }

  /** stop() の別名。SessionState リセット時に呼ぶ。 */
  reset(): void {
    this.stop();
  }

  /** 現在の状態スナップショットを返す。 */
  getSnapshot(): TimerSnapshot {
    if (this.#config === null || this.#startedAt === null) {
      return {
        phase: 'idle',
        remainingMs: 0,
        currentSet: 0,
        totalSets: this.#totalSets,
        startedAt: null,
      };
    }
    const elapsed = Date.now() - this.#startedAt;
    const { phase, currentSet, phaseRemainingMs } = computePhase(elapsed, this.#config);
    return {
      phase,
      remainingMs: phaseRemainingMs,
      currentSet,
      totalSets: this.#totalSets,
      startedAt: this.#startedAt,
    };
  }

  #tick(): void {
    if (this.#config === null || this.#startedAt === null) {
      return;
    }
    const snapshot = this.getSnapshot();
    const prevPhase = this.#currentPhase;
    const nextPhase = snapshot.phase;

    if (nextPhase !== prevPhase) {
      this.#currentPhase = nextPhase;
      this.emit('phaseChange', snapshot);
      if (nextPhase === 'countdown') {
        this.emit('countdown', snapshot);
      }
      if (nextPhase === 'ended') {
        this.emit('ended', snapshot);
        // ended で停止し phase を保持する (idle 復帰は reset() 側の責務)。
        this.#stopInterval();
        return;
      }
    }
    this.emit('tick', snapshot);
  }

  #stopInterval(): void {
    if (this.#interval !== null) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
  }

  // any を使わない型付き on / emit。
  override on<K extends keyof TimerEventMap>(
    event: K,
    listener: (...args: TimerEventMap[K]) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof TimerEventMap>(event: K, ...args: TimerEventMap[K]): boolean {
    return super.emit(event, ...args);
  }
}
