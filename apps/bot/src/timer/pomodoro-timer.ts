import { EventEmitter } from 'node:events';
import type { TimerConfig, TimerPhase, TimerSnapshot } from '@co-working-call/shared';
import { TICK_MS, computeContinuousPhase, computePhase } from './phase.js';

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
  /**
   * 「続行」継続モードか。true の間は finalBreak/countdown/ended を持たず work/break を
   * 無限ループする (終了は VC 0 人 or 23時間キャップで外部から reset される)。
   */
  #continuous = false;
  #continuousWorkSec = 0;
  #continuousBreakSec = 0;
  /**
   * 継続開始までに実施済みの作業セット数 (元セッションの sets)。継続中の表示は
   * この値に継続サイクル数を足した「累計の実施セット数」を currentSet として返す。
   */
  #continuousBaseSets = 0;

  /** タイマー開始。動作中なら一旦停止してから開始する。 */
  start(config: TimerConfig): void {
    this.#stopInterval();
    this.#continuous = false;
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

  /**
   * 「続行」継続モードで開始する (US-続行)。開始時の作業/休憩時間で work/break を無限ループし、
   * countdown/ended は発火しない。startedAt は再採番する (継続ループ自体の経過起点)。
   * baseSets は継続開始までに実施済みの作業セット数 (元セッションの sets) で、継続中の
   * currentSet は baseSets + 継続サイクル数 (累計の実施セット数) として返す。
   * 23時間キャップはセッション開始時刻基準で EmbedManager が別管理する。
   */
  startContinuous(workSec: number, breakSec: number, baseSets: number): void {
    this.#stopInterval();
    this.#continuous = true;
    this.#continuousWorkSec = workSec;
    this.#continuousBreakSec = breakSec;
    this.#continuousBaseSets = baseSets;
    this.#config = null;
    this.#totalSets = 0;
    this.#startedAt = Date.now();
    this.#currentPhase = 'idle';
    this.#tick();
    this.#interval = setInterval(() => {
      this.#tick();
    }, TICK_MS);
  }

  /** タイマーを停止し idle に戻す (手動停止)。 */
  stop(): void {
    const wasRunning = this.#startedAt !== null;
    this.#stopInterval();
    this.#continuous = false;
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
    // 継続モード: work/break を無限ループし、currentSet は「累計の実施セット数」
    // (元セッションの実施セット数 baseSets + 継続サイクル数 cycle)。
    if (this.#continuous && this.#startedAt !== null) {
      const elapsed = Date.now() - this.#startedAt;
      const { phase, cycle, phaseRemainingMs } = computeContinuousPhase(
        elapsed,
        this.#continuousWorkSec,
        this.#continuousBreakSec,
      );
      return {
        phase,
        remainingMs: phaseRemainingMs,
        currentSet: this.#continuousBaseSets + cycle,
        totalSets: 0,
        startedAt: this.#startedAt,
        continuous: true,
      };
    }
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
    // 通常モードは #config 必須。継続モードは #startedAt のみで駆動する。
    if (this.#startedAt === null || (!this.#continuous && this.#config === null)) {
      return;
    }
    const snapshot = this.getSnapshot();
    const prevPhase = this.#currentPhase;
    const nextPhase = snapshot.phase;

    if (nextPhase !== prevPhase) {
      this.#currentPhase = nextPhase;
      this.emit('phaseChange', snapshot);
      // 継続モードは countdown/ended を持たず work/break のループのみ。
      if (!this.#continuous) {
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
