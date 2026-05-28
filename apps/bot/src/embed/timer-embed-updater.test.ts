import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import {
  TIMER_EMBED_UPDATE_INTERVAL_MS,
  TIMER_EMBED_UPDATE_SAFETY_MARGIN_MS,
  TimerEmbedUpdater,
  computeNextDelay,
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

function makeSnapshot(phase: TimerSnapshot['phase'], remainingMs = 60_000): TimerSnapshot {
  return { phase, remainingMs, currentSet: 1, totalSets: 4, startedAt: 0 };
}

/**
 * Date.now() ベースで remainingMs を減らす動的 source。
 * 自己補正 setTimeout チェインは毎回 getSnapshot() を読むため、静的 source だと
 * 同じ delay が繰り返され実本番と挙動が乖離する。fake timer は Date.now() も
 * 進めるので、これで「実際の経過に応じて残りが減る」状況を再現する。
 */
function makeDecreasingSource(
  initialRemainingMs: number,
  phase: TimerSnapshot['phase'] = 'work',
): SnapshotSource {
  const startedAt = Date.now();
  return {
    getSnapshot: (): TimerSnapshot => ({
      phase,
      remainingMs: initialRemainingMs - (Date.now() - startedAt),
      currentSet: 1,
      totalSets: 4,
      startedAt,
    }),
  };
}

describe('computeNextDelay (分境界吸着 + 安全マージン)', () => {
  it('既定 interval=60,000ms / margin=50ms', () => {
    expect(TIMER_EMBED_UPDATE_INTERVAL_MS).toBe(60_000);
    expect(TIMER_EMBED_UPDATE_SAFETY_MARGIN_MS).toBe(50);
  });

  it('境界より大きく離れた残り: 境界手前まで待つ (margin 差し引き)', () => {
    // remaining=1,499,200 → 次の分境界 1,440,000 までは 59,200ms、その 50ms 手前。
    expect(computeNextDelay(1_499_200)).toBe(59_150);
  });

  it('境界ちょうどの残り: 即時 update は冗長なので 1 つ先の境界手前まで待つ', () => {
    // remaining=1,500,000 (25 分ちょうど) → ((1,499,999%60,000)+1)=60,000, 50 引いて 59,950ms。
    expect(computeNextDelay(1_500_000)).toBe(59_950);
  });

  it('境界をジッタで僅かに越えた残り: マイナス値を 1 つ先の境界に飛ばす', () => {
    // remaining=1,440,030 (境界 1,440,000 を 30ms 過ぎた) → toBoundary=30, 30-50=-20 → +60,000=59,980。
    expect(computeNextDelay(1_440_030)).toBe(59_980);
  });

  it('残り 1ms: 最小 toBoundary を 1 つ先の境界手前へ', () => {
    // remaining=1 → ((0%60,000)+1)=1, 1-50=-49 → +60,000=59,951。
    expect(computeNextDelay(1)).toBe(59_951);
  });

  it('interval / margin 引数を差し替えられる (テスト容易性)', () => {
    expect(computeNextDelay(10_000, 1_000, 100)).toBe(900);
  });
});

describe('TimerEmbedUpdater', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('分境界吸着 + 自己補正で 60 秒ごとに edit する (動的 source)', () => {
    const edit = vi.fn(() => Promise.resolve());
    const message: EditableMessage = { edit };
    // 残り 25 分ちょうどから開始: 初回 59,950ms 後 → 以降 60,000ms ごとに発火。
    const source = makeDecreasingSource(1_500_000);
    const updater = new TimerEmbedUpdater(message, source, config);

    updater.start();
    vi.advanceTimersByTime(59_949);
    expect(edit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(edit).toHaveBeenCalledTimes(1);
    // 2 回目は 60,000ms 後。
    vi.advanceTimersByTime(59_999);
    expect(edit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(edit).toHaveBeenCalledTimes(2);
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
    const updater = new TimerEmbedUpdater({ edit }, makeDecreasingSource(1_500_000), config);

    updater.start();
    // 境界吸着の setTimeout 中 (まだ未発火) で stop する。
    vi.advanceTimersByTime(1_000);
    updater.stop();
    vi.advanceTimersByTime(TIMER_EMBED_UPDATE_INTERVAL_MS * 3);
    expect(edit).not.toHaveBeenCalled();
  });
});
