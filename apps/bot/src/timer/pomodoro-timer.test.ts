import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimerConfig, TimerSnapshot } from '@co-working-call/shared';
import { PomodoroTimer } from './pomodoro-timer.js';

// work1 60s + break1 30s + work2 60s + finalBreak本体 60s + countdown 10s = 220s
const config: TimerConfig = { workSec: 60, breakSec: 30, sets: 2, finalBreakSec: 70 };

describe('PomodoroTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start で work(1) に遷移し phaseChange が発火する', () => {
    const timer = new PomodoroTimer();
    const phases: string[] = [];
    timer.on('phaseChange', (s) => phases.push(s.phase));

    timer.start(config);

    const snap = timer.getSnapshot();
    expect(snap.phase).toBe('work');
    expect(snap.currentSet).toBe(1);
    expect(snap.totalSets).toBe(2);
    expect(snap.startedAt).not.toBeNull();
    expect(phases).toEqual(['work']);
    timer.reset();
  });

  it('全フェーズを順番に遷移する', () => {
    const timer = new PomodoroTimer();
    const transitions: string[] = [];
    timer.on('phaseChange', (s) => transitions.push(`${s.phase}#${String(s.currentSet)}`));

    timer.start(config);
    vi.advanceTimersByTime(220_000);

    expect(transitions).toEqual([
      'work#1',
      'break#1',
      'work#2',
      'finalBreak#2',
      'countdown#2',
      'ended#2',
    ]);
    timer.reset();
  });

  it('finalBreak 残り10秒で countdown イベントが1回発火する', () => {
    const timer = new PomodoroTimer();
    const events: string[] = [];
    timer.on('countdown', () => events.push('countdown'));

    timer.start(config);
    vi.advanceTimersByTime(210_000);

    expect(events).toEqual(['countdown']);
    const snap = timer.getSnapshot();
    expect(snap.phase).toBe('countdown');
    expect(snap.remainingMs).toBe(10_000);
    timer.reset();
  });

  it('ended で停止し phase=ended を保持、reset で idle に戻る', () => {
    const timer = new PomodoroTimer();
    let endedSnap: TimerSnapshot | null = null;
    timer.on('ended', (s) => {
      endedSnap = s;
    });

    timer.start(config);
    vi.advanceTimersByTime(220_000);

    expect(endedSnap).not.toBeNull();
    expect(timer.getSnapshot().phase).toBe('ended');

    // ended 後さらに時間を進めても tick は止まっており ended を保持。
    vi.advanceTimersByTime(60_000);
    expect(timer.getSnapshot().phase).toBe('ended');

    timer.reset();
    expect(timer.getSnapshot().phase).toBe('idle');
  });

  it('stop で idle に戻り stopped イベントが発火する', () => {
    const timer = new PomodoroTimer();
    const events: string[] = [];
    timer.on('stopped', () => events.push('stopped'));

    timer.start(config);
    vi.advanceTimersByTime(5_000);
    timer.stop();

    expect(events).toEqual(['stopped']);
    expect(timer.getSnapshot().phase).toBe('idle');
  });

  it('tick イベントが毎秒発火する', () => {
    const timer = new PomodoroTimer();
    let ticks = 0;
    timer.on('tick', () => {
      ticks += 1;
    });

    timer.start(config);
    vi.advanceTimersByTime(10_000);

    // start 直後の即時 tick + 10 回。
    expect(ticks).toBe(11);
    timer.reset();
  });
});
