import { z } from 'zod';

/**
 * タイマー1回分の設定。
 * 範囲は docs/spec.md に準拠
 * (workSec 60-3600 / breakSec 60-1800 / sets 1-20 / finalBreakSec 60-1800)。
 */
export const TimerConfigSchema = z.object({
  workSec: z.number().int().min(60).max(3600),
  breakSec: z.number().int().min(60).max(1800),
  sets: z.number().int().min(1).max(20),
  finalBreakSec: z.number().int().min(60).max(1800),
});
export type TimerConfig = z.infer<typeof TimerConfigSchema>;

/** フェーズ遷移: idle → work → break → ... → finalBreak → countdown → ended */
export const TIMER_PHASES = ['idle', 'work', 'break', 'finalBreak', 'countdown', 'ended'] as const;
export const TimerPhaseSchema = z.enum(TIMER_PHASES);
export type TimerPhase = z.infer<typeof TimerPhaseSchema>;

/** タイマー状態のスナップショット (Date.now() ベースの整数値)。 */
export const TimerSnapshotSchema = z.object({
  phase: TimerPhaseSchema,
  remainingMs: z.number().int(),
  currentSet: z.number().int(),
  totalSets: z.number().int(),
  startedAt: z.number().int().nullable(),
});
export type TimerSnapshot = z.infer<typeof TimerSnapshotSchema>;
