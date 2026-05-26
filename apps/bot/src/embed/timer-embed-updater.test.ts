import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import {
  TIMER_EMBED_UPDATE_INTERVAL_MS,
  TimerEmbedUpdater,
  type EditableMessage,
  type SnapshotSource,
} from './timer-embed-updater.js';

const config: BotConfig = {
  default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 },
  guildId: 'g',
  voiceChannelId: 'v',
  adminRoleName: 'pomo-admin',
  adminRoleNames: [],
};

function makeSnapshot(phase: TimerSnapshot['phase'], remainingMs = 1_000): TimerSnapshot {
  return { phase, remainingMs, currentSet: 1, totalSets: 4, startedAt: 0 };
}

describe('TimerEmbedUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('境界吸着後は 5秒ごとに edit する', () => {
    const edit = vi.fn(() => Promise.resolve());
    const message: EditableMessage = { edit };
    // remainingMs=1000 は境界吸着待ち 1000ms 後に初回 update → 以降 5,000ms 間隔。
    const source: SnapshotSource = { getSnapshot: () => makeSnapshot('work', 1_000) };
    const updater = new TimerEmbedUpdater(message, source, config);

    updater.start();
    // 初回境界待ち 1000ms + 5000ms*2 = 11000ms で 3 回発火する。
    vi.advanceTimersByTime(1_000 + TIMER_EMBED_UPDATE_INTERVAL_MS * 2);
    expect(edit).toHaveBeenCalledTimes(3);
    updater.stop();
  });

  it('countdown / ended はスキップする', () => {
    const edit = vi.fn(() => Promise.resolve());
    let phase: TimerSnapshot['phase'] = 'countdown';
    const updater = new TimerEmbedUpdater(
      { edit },
      { getSnapshot: () => makeSnapshot(phase) },
      config,
    );

    updater.start();
    vi.advanceTimersByTime(TIMER_EMBED_UPDATE_INTERVAL_MS * 2);
    expect(edit).not.toHaveBeenCalled();
    phase = 'ended';
    vi.advanceTimersByTime(TIMER_EMBED_UPDATE_INTERVAL_MS);
    expect(edit).not.toHaveBeenCalled();
    updater.stop();
  });

  it('stop 後は edit されない (境界待ち中の setTimeout も解除される)', () => {
    const edit = vi.fn(() => Promise.resolve());
    const updater = new TimerEmbedUpdater(
      { edit },
      { getSnapshot: () => makeSnapshot('work', 60_000) },
      config,
    );

    updater.start();
    // 境界吸着の setTimeout 中 (まだ未発火) で stop する。
    vi.advanceTimersByTime(1_000);
    updater.stop();
    vi.advanceTimersByTime(TIMER_EMBED_UPDATE_INTERVAL_MS * 3);
    expect(edit).not.toHaveBeenCalled();
  });

  it('5の倍数秒境界に吸着: 残り 59,200ms → 4,200ms 待ち → 以降 5,000ms ごと', () => {
    const edit = vi.fn(() => Promise.resolve());
    const updater = new TimerEmbedUpdater(
      { edit },
      { getSnapshot: () => makeSnapshot('work', 59_200) },
      config,
    );

    updater.start();
    // 4,199ms ではまだ初回 update が来ていない。
    vi.advanceTimersByTime(4_199);
    expect(edit).not.toHaveBeenCalled();
    // 4,200ms ちょうどで初回 update。
    vi.advanceTimersByTime(1);
    expect(edit).toHaveBeenCalledTimes(1);
    // 以降は 5,000ms ごとに発火 (4,999ms 経過時点ではまだ 1 回)。
    vi.advanceTimersByTime(4_999);
    expect(edit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(edit).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(TIMER_EMBED_UPDATE_INTERVAL_MS);
    expect(edit).toHaveBeenCalledTimes(3);
    updater.stop();
  });

  it('残り 55,000ms (既に5の倍数秒境界) → 5,000ms 待ち (即時 update は冗長なので避ける)', () => {
    const edit = vi.fn(() => Promise.resolve());
    const updater = new TimerEmbedUpdater(
      { edit },
      { getSnapshot: () => makeSnapshot('work', 55_000) },
      config,
    );

    updater.start();
    // post 直後の表示が既に "00:55" なので、5,000ms 後の "00:50" まで待つ。
    vi.advanceTimersByTime(4_999);
    expect(edit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(edit).toHaveBeenCalledTimes(1);
    updater.stop();
  });
});
