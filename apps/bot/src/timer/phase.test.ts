import { describe, expect, it } from 'vitest';
import type { TimerConfig } from '@co-working-call/shared';
import { COUNTDOWN_LEAD_MS, buildSegments, computeContinuousPhase, computePhase } from './phase.js';

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

describe('computeContinuousPhase', () => {
  // 1 サイクル = work 60s + break 30s = 90s。
  const workSec = 60;
  const breakSec = 30;

  it('開始直後は work / cycle=1', () => {
    expect(computeContinuousPhase(0, workSec, breakSec)).toEqual({
      phase: 'work',
      cycle: 1,
      phaseRemainingMs: 60_000,
    });
  });

  it('work→break の境界で切り替わる (cycle は据え置き)', () => {
    expect(computeContinuousPhase(59_999, workSec, breakSec).phase).toBe('work');
    const b = computeContinuousPhase(60_000, workSec, breakSec);
    expect(b.phase).toBe('break');
    expect(b.cycle).toBe(1);
    expect(b.phaseRemainingMs).toBe(30_000);
  });

  it('次サイクル先頭で cycle が増えて work に戻る', () => {
    expect(computeContinuousPhase(89_999, workSec, breakSec).phase).toBe('break');
    const w2 = computeContinuousPhase(90_000, workSec, breakSec);
    expect(w2.phase).toBe('work');
    expect(w2.cycle).toBe(2);
    expect(w2.phaseRemainingMs).toBe(60_000);
  });

  it('長時間経過しても終端に達さず work/break を繰り返す', () => {
    // 100 サイクル目の break 帯。
    const t = 90_000 * 99 + 70_000;
    const r = computeContinuousPhase(t, workSec, breakSec);
    expect(r.phase).toBe('break');
    expect(r.cycle).toBe(100);
  });

  it('負の経過時間は 0 として扱う', () => {
    expect(computeContinuousPhase(-100, workSec, breakSec)).toEqual({
      phase: 'work',
      cycle: 1,
      phaseRemainingMs: 60_000,
    });
  });
});
