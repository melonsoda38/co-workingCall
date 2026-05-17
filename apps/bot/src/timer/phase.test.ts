import { describe, expect, it } from 'vitest';
import type { TimerConfig } from '@co-working-call/shared';
import { COUNTDOWN_LEAD_MS, buildSegments, computePhase } from './phase.js';

// work1 60s + break1 30s + work2 60s + finalBreak本体 60s + countdown 10s = 220s
const config: TimerConfig = { workSec: 60, breakSec: 30, sets: 2, finalBreakSec: 70 };

describe('buildSegments', () => {
  it('work N回 + break N-1回 + finalBreak + countdown を構築する', () => {
    const segments = buildSegments(config);
    expect(segments.map((s) => s.phase)).toEqual([
      'work',
      'break',
      'work',
      'finalBreak',
      'countdown',
    ]);
    expect(segments.at(-1)?.durationMs).toBe(COUNTDOWN_LEAD_MS);
  });

  it('sets=1 のとき break は無い', () => {
    const segments = buildSegments({ ...config, sets: 1 });
    expect(segments.map((s) => s.phase)).toEqual(['work', 'finalBreak', 'countdown']);
  });
});

describe('computePhase', () => {
  it('開始直後は work(1)', () => {
    expect(computePhase(0, config)).toEqual({
      phase: 'work',
      currentSet: 1,
      phaseRemainingMs: 60_000,
    });
  });

  it('work(1) 終了境界で break(1) に切り替わる', () => {
    expect(computePhase(59_999, config).phase).toBe('work');
    expect(computePhase(60_000, config).phase).toBe('break');
    expect(computePhase(60_000, config).currentSet).toBe(1);
  });

  it('finalBreak 残り10秒で countdown に突入する', () => {
    // 60 + 30 + 60 + 60 = 210s で countdown
    expect(computePhase(209_999, config).phase).toBe('finalBreak');
    const c = computePhase(210_000, config);
    expect(c.phase).toBe('countdown');
    expect(c.phaseRemainingMs).toBe(10_000);
  });

  it('総時間到達で ended になる', () => {
    expect(computePhase(220_000, config)).toEqual({
      phase: 'ended',
      currentSet: 2,
      phaseRemainingMs: 0,
    });
    expect(computePhase(999_999, config).phase).toBe('ended');
  });

  it('負の経過時間は 0 として扱う', () => {
    expect(computePhase(-100, config).phase).toBe('work');
  });
});
