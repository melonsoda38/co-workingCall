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
};

function makeSnapshot(phase: TimerSnapshot['phase']): TimerSnapshot {
  return { phase, remainingMs: 1_000, currentSet: 1, totalSets: 4, startedAt: 0 };
}

describe('TimerEmbedUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('work 中は 5秒ごとに edit する', () => {
    const edit = vi.fn(() => Promise.resolve());
    const message: EditableMessage = { edit };
    const source: SnapshotSource = { getSnapshot: () => makeSnapshot('work') };
    const updater = new TimerEmbedUpdater(message, source, config);

    updater.start();
    vi.advanceTimersByTime(TIMER_EMBED_UPDATE_INTERVAL_MS * 3);
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

  it('stop 後は edit されない', () => {
    const edit = vi.fn(() => Promise.resolve());
    const updater = new TimerEmbedUpdater(
      { edit },
      { getSnapshot: () => makeSnapshot('work') },
      config,
    );

    updater.start();
    vi.advanceTimersByTime(TIMER_EMBED_UPDATE_INTERVAL_MS);
    updater.stop();
    vi.advanceTimersByTime(TIMER_EMBED_UPDATE_INTERVAL_MS * 3);
    expect(edit).toHaveBeenCalledTimes(1);
  });
});
