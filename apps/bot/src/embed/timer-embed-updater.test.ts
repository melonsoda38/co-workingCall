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

function makeSnapshot(phase: TimerSnapshot['phase'], remainingMs = 1_000): TimerSnapshot {
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

describe('computeNextDelay (5の倍数秒境界吸着 + 安全マージン)', () => {
  it('境界より大きく離れた残り: 境界手前まで待つ (margin=50ms 差し引き)', () => {
    // remaining=59,200 → 次の境界 55,000 までは 4,200ms、その 50ms 手前 = 4,150ms。
    expect(computeNextDelay(59_200)).toBe(4_150);
  });

  it('境界ちょうどの残り: 即時 update は冗長なので 1 つ先の境界手前まで待つ', () => {
    // remaining=55,000 → ((54,999%5000)+1)=5,000, 50 引いて 4,950ms 後 (次の "00:50" 手前)。
    expect(computeNextDelay(55_000)).toBe(4_950);
  });

  it('境界をジッタで僅かに越えた残り: マイナス値を 1 つ先の境界に飛ばす', () => {
    // remaining=55,030 → ((55,029%5000)+1)=30, 30-50=-20 → -20+5000=4,980ms 後。
    expect(computeNextDelay(55_030)).toBe(4_980);
  });

  it('残り 1ms: 最小 delay (= INTERVAL - margin + 1) で次の境界手前へ', () => {
    // remaining=1 → ((0%5000)+1)=1, 1-50=-49 → -49+5000=4,951ms 後。
    expect(computeNextDelay(1)).toBe(4_951);
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

  it('境界吸着 + 自己補正で 5秒ごとに edit する (動的 source)', () => {
    const edit = vi.fn(() => Promise.resolve());
    const message: EditableMessage = { edit };
    // 残り 59,200ms から開始: 初回 4,150ms 後 → 以降 5,000ms ごとに発火。
    const source = makeDecreasingSource(59_200);
    const updater = new TimerEmbedUpdater(message, source, config);

    updater.start();
    // 初回 (4,150ms 後)。
    vi.advanceTimersByTime(4_149);
    expect(edit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(edit).toHaveBeenCalledTimes(1);
    // 2 回目 (累計 9,150ms)。
    vi.advanceTimersByTime(4_999);
    expect(edit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(edit).toHaveBeenCalledTimes(2);
    // 3 回目 (累計 14,150ms)。
    vi.advanceTimersByTime(TIMER_EMBED_UPDATE_INTERVAL_MS);
    expect(edit).toHaveBeenCalledTimes(3);
    updater.stop();
  });

  it('境界一致の動的 source: 初回は 4,950ms 後 → 以降 5,000ms ごと', () => {
    const edit = vi.fn(() => Promise.resolve());
    const source = makeDecreasingSource(55_000);
    const updater = new TimerEmbedUpdater({ edit }, source, config);

    updater.start();
    vi.advanceTimersByTime(4_949);
    expect(edit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(edit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TIMER_EMBED_UPDATE_INTERVAL_MS);
    expect(edit).toHaveBeenCalledTimes(2);
    updater.stop();
  });

  it('発火時に表示される残り秒は常に 5 の倍数 (Math.floor 切り捨て耐性)', () => {
    const captured: number[] = [];
    const source = makeDecreasingSource(59_200);
    const updater = new TimerEmbedUpdater(
      {
        edit: () => {
          // edit 呼出時点で source.getSnapshot() の秒値を記録する。
          captured.push(Math.floor(source.getSnapshot().remainingMs / 1000));
          return Promise.resolve();
        },
      },
      source,
      config,
    );

    updater.start();
    // 6 回ぶん進める (4,150 + 5,000 * 5 = 29,150ms)。
    vi.advanceTimersByTime(4_150 + TIMER_EMBED_UPDATE_INTERVAL_MS * 5);
    updater.stop();

    expect(captured.length).toBe(6);
    // 全て秒値の 1 の位が 0 or 5 (= 5 の倍数)。
    for (const sec of captured) {
      expect(sec % 5).toBe(0);
    }
    // 連続する 6 回は 5 ずつ減る (55, 50, 45, 40, 35, 30 のような並び)。
    expect(captured).toEqual([55, 50, 45, 40, 35, 30]);
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
    const updater = new TimerEmbedUpdater({ edit }, makeDecreasingSource(60_000), config);

    updater.start();
    // 境界吸着の setTimeout 中 (まだ未発火) で stop する。
    vi.advanceTimersByTime(1_000);
    updater.stop();
    vi.advanceTimersByTime(TIMER_EMBED_UPDATE_INTERVAL_MS * 3);
    expect(edit).not.toHaveBeenCalled();
  });

  it('SAFETY_MARGIN_MS は 50ms (jitter 吸収のための定数を export)', () => {
    expect(TIMER_EMBED_UPDATE_SAFETY_MARGIN_MS).toBe(50);
  });
});
