import type { TimerConfig, TimerPhase } from '@co-working-call/shared';

/** countdown フェーズに入る finalBreak 残り時間 (ms)。ending-spec.md: 残り10秒。 */
export const COUNTDOWN_LEAD_MS = 10_000;

/**
 * 1 tick の間隔 (ms)。時間計算は常に Date.now() の差分で行い、
 * これはフェーズ遷移を検知するための定期チェック用 (時間を数える用途ではない)。
 */
export const TICK_MS = 1_000;

/** computePhase の結果。 */
export interface PhaseResolution {
  phase: TimerPhase;
  /** 現在の work セット番号 (1..N)。break(i) 中も i。finalBreak/countdown/ended は N。 */
  currentSet: number;
  /** 現フェーズの残り時間 (ms)。0 以上。 */
  phaseRemainingMs: number;
}

/** タイムライン上の1区間。idle/ended は区間を持たない。 */
interface Segment {
  phase: Exclude<TimerPhase, 'idle' | 'ended'>;
  set: number;
  durationMs: number;
}

/**
 * config からセグメント列を構築する。
 * idle → work(1) → break(1) → ... → work(N) → finalBreak → countdown
 * break は work(i) (i<N) の後のみ。finalBreak の末尾 10 秒は countdown。
 */
export function buildSegments(config: TimerConfig): Segment[] {
  const { workSec, breakSec, sets, finalBreakSec } = config;
  const segments: Segment[] = [];
  for (let i = 1; i <= sets; i++) {
    segments.push({ phase: 'work', set: i, durationMs: workSec * 1000 });
    if (i < sets) {
      segments.push({ phase: 'break', set: i, durationMs: breakSec * 1000 });
    }
  }
  // finalBreakSec は最小 60 のため finalBreak 本体は必ず正の長さになる。
  const finalBreakMs = finalBreakSec * 1000;
  segments.push({
    phase: 'finalBreak',
    set: sets,
    durationMs: finalBreakMs - COUNTDOWN_LEAD_MS,
  });
  segments.push({ phase: 'countdown', set: sets, durationMs: COUNTDOWN_LEAD_MS });
  return segments;
}

/**
 * 経過時間から現在フェーズ・セット番号・現フェーズ残りを算出する純粋関数。
 * Date 非依存なので単体テストしやすい。負値は 0 として扱う。
 */
export function computePhase(elapsedMs: number, config: TimerConfig): PhaseResolution {
  const elapsed = elapsedMs < 0 ? 0 : elapsedMs;
  let acc = 0;
  for (const segment of buildSegments(config)) {
    const end = acc + segment.durationMs;
    if (elapsed < end) {
      return {
        phase: segment.phase,
        currentSet: segment.set,
        phaseRemainingMs: end - elapsed,
      };
    }
    acc = end;
  }
  return { phase: 'ended', currentSet: config.sets, phaseRemainingMs: 0 };
}
