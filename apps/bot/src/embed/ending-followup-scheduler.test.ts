import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EndingFollowupScheduler } from './ending-followup-scheduler.js';

const DELAY_MS = 15_000;

describe('EndingFollowupScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedule は delayMs 後に run を一度だけ呼ぶ', () => {
    const scheduler = new EndingFollowupScheduler(DELAY_MS);
    const run = vi.fn();
    scheduler.schedule(run);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DELAY_MS);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancel すると run は呼ばれない', () => {
    const scheduler = new EndingFollowupScheduler(DELAY_MS);
    const run = vi.fn();
    scheduler.schedule(run);
    scheduler.cancel();
    vi.advanceTimersByTime(DELAY_MS);
    expect(run).not.toHaveBeenCalled();
  });

  it('schedule を上書きすると前の予約は破棄され最新の run のみ実行される', () => {
    const scheduler = new EndingFollowupScheduler(DELAY_MS);
    const first = vi.fn();
    const second = vi.fn();
    scheduler.schedule(first);
    scheduler.schedule(second);
    vi.advanceTimersByTime(DELAY_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
