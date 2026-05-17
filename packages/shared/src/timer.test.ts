import { describe, it, expect } from 'vitest';
import { TIMER_PHASES, TimerConfigSchema, TimerPhaseSchema, TimerSnapshotSchema } from './timer.js';

describe('TimerConfigSchema', () => {
  const valid = { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 600 };

  it('有効な設定を受理する', () => {
    expect(TimerConfigSchema.parse(valid)).toEqual(valid);
  });

  it('境界値 (最小・最大) を受理する', () => {
    expect(
      TimerConfigSchema.safeParse({ workSec: 60, breakSec: 60, sets: 1, finalBreakSec: 60 })
        .success,
    ).toBe(true);
    expect(
      TimerConfigSchema.safeParse({
        workSec: 3600,
        breakSec: 1800,
        sets: 20,
        finalBreakSec: 1800,
      }).success,
    ).toBe(true);
  });

  it('範囲外を拒否する', () => {
    expect(TimerConfigSchema.safeParse({ ...valid, workSec: 59 }).success).toBe(false);
    expect(TimerConfigSchema.safeParse({ ...valid, workSec: 3601 }).success).toBe(false);
    expect(TimerConfigSchema.safeParse({ ...valid, breakSec: 1801 }).success).toBe(false);
    expect(TimerConfigSchema.safeParse({ ...valid, sets: 0 }).success).toBe(false);
    expect(TimerConfigSchema.safeParse({ ...valid, sets: 21 }).success).toBe(false);
    expect(TimerConfigSchema.safeParse({ ...valid, finalBreakSec: 59 }).success).toBe(false);
  });

  it('非整数を拒否する', () => {
    expect(TimerConfigSchema.safeParse({ ...valid, workSec: 60.5 }).success).toBe(false);
  });
});

describe('TimerPhaseSchema', () => {
  it('全フェーズを受理する', () => {
    for (const phase of TIMER_PHASES) {
      expect(TimerPhaseSchema.parse(phase)).toBe(phase);
    }
  });

  it('未知のフェーズを拒否する', () => {
    expect(TimerPhaseSchema.safeParse('paused').success).toBe(false);
  });
});

describe('TimerSnapshotSchema', () => {
  it('startedAt あり/null いずれも受理する', () => {
    expect(
      TimerSnapshotSchema.safeParse({
        phase: 'work',
        remainingMs: 1_500_000,
        currentSet: 1,
        totalSets: 4,
        startedAt: 1_700_000_000_000,
      }).success,
    ).toBe(true);
    expect(
      TimerSnapshotSchema.safeParse({
        phase: 'idle',
        remainingMs: 0,
        currentSet: 0,
        totalSets: 4,
        startedAt: null,
      }).success,
    ).toBe(true);
  });

  it('不正な phase を拒否する', () => {
    expect(
      TimerSnapshotSchema.safeParse({
        phase: 'xxx',
        remainingMs: 0,
        currentSet: 0,
        totalSets: 1,
        startedAt: null,
      }).success,
    ).toBe(false);
  });
});
