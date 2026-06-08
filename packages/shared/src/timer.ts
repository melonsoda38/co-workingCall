import { z } from 'zod';

/**
 * タイマー1回分の設定。
 * 範囲は docs/spec.md に準拠
 * (workSec 60-59940 / breakSec 60-59940 / sets 1-999 / finalBreakSec 60-59940)。
 * 時間系の最大 59,940秒 = 999分。最小は 60秒 = 1分。
 */
export const TimerConfigSchema = z.object({
  workSec: z
    .number()
    .int()
    .min(60)
    .max(999 * 60),
  breakSec: z
    .number()
    .int()
    .min(60)
    .max(999 * 60),
  sets: z.number().int().min(1).max(999),
  finalBreakSec: z
    .number()
    .int()
    .min(60)
    .max(999 * 60),
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
  /**
   * 「続行」による継続ループ中なら true (省略時は通常セッション扱い)。
   * 継続中は countdown/ended に達せず work/break を無限に繰り返し、currentSet を
   * 「継続回数 (cycle)」として使う (totalSets は 0)。画像表示の出し分けに用いる。
   */
  continuous: z.boolean().optional(),
});
export type TimerSnapshot = z.infer<typeof TimerSnapshotSchema>;
