import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MessageCreateOptions } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import { TimerEmbedController } from './timer-embed-controller.js';
import type { EmbedChannel, PostedMessage } from './embed-manager.js';

const config: BotConfig = {
  default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 },
  guildId: '1001',
  voiceChannelId: 'vc',
  adminRoleName: 'pomo-admin',
  adminRoleNames: [],
  volumes: { workEnd: 0, breakEnd: 0, finalStart: 0, countdownWarning: 0, finish: 0 },
  autoStart: { time: null, label: '自動スタート' },
};

function makeSnapshot(phase: TimerSnapshot['phase']): TimerSnapshot {
  return { phase, remainingMs: 1_000, currentSet: 1, totalSets: 4, startedAt: 0 };
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

function fakeChannel() {
  const calls: string[] = [];
  let n = 0;
  const post = vi.fn<(options: MessageCreateOptions) => Promise<PostedMessage>>(() => {
    calls.push('post');
    n += 1;
    return Promise.resolve({ id: `m${String(n)}` });
  });
  const edit = vi.fn<(messageId: string, options: unknown) => Promise<void>>(() => {
    calls.push('edit');
    return Promise.resolve();
  });
  const del = vi.fn<(messageId: string) => Promise<void>>(() => {
    calls.push('delete');
    return Promise.resolve();
  });
  const purgeOwnEmbeds = vi.fn<() => Promise<void>>(() => {
    calls.push('purge');
    return Promise.resolve();
  });
  const purgeOwnTexts = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const channel: EmbedChannel = { post, edit, delete: del, purgeOwnEmbeds, purgeOwnTexts };
  return { channel, post, edit, del, purgeOwnEmbeds, calls };
}

function makeController(phase: TimerSnapshot['phase'] = 'work') {
  const ch = fakeChannel();
  const snapshot = { current: makeSnapshot(phase) };
  const timer = { getSnapshot: (): TimerSnapshot => snapshot.current };
  const controller = new TimerEmbedController({ channel: ch.channel, timer, config, logger });
  return { controller, snapshot, ...ch };
}

describe('TimerEmbedController', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('初期状態では id は null', () => {
    const { controller } = makeController();
    expect(controller.id).toBeNull();
  });

  it('post は purge → post の順で投稿し id を保持する', async () => {
    const { controller, calls, purgeOwnEmbeds, post } = makeController('work');
    await controller.post();
    expect(purgeOwnEmbeds).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['purge', 'post']); // purge が post より先
    expect(controller.id).toBe('m1');
  });

  it('repost: 表示フェーズなら旧 Embed 削除 → purge → 再投稿', async () => {
    const { controller, calls, del } = makeController('work');
    await controller.post(); // id=m1
    await controller.repost();
    expect(del).toHaveBeenCalledWith('m1');
    // delete → purge → post の順
    expect(calls).toEqual(['purge', 'post', 'delete', 'purge', 'post']);
    expect(controller.id).toBe('m2');
  });

  it('repost: 非表示フェーズ (ended 等) は no-op で Embed を尊重する', async () => {
    const { controller, snapshot, del, post } = makeController('work');
    await controller.post();
    post.mockClear();
    del.mockClear();
    snapshot.current = makeSnapshot('ended');
    await controller.repost();
    expect(del).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(controller.id).toBe('m1'); // 変わらない
  });

  it('deleteEmbed は delete を呼び id を手放す', async () => {
    const { controller, del } = makeController('work');
    await controller.post();
    await controller.deleteEmbed();
    expect(del).toHaveBeenCalledWith('m1');
    expect(controller.id).toBeNull();
  });

  it('deleteEmbed は id 未保持なら no-op', async () => {
    const { controller, del } = makeController('work');
    await controller.deleteEmbed();
    expect(del).not.toHaveBeenCalled();
  });

  it('editForCountdown は id 保持時のみ edit する', async () => {
    const { controller, edit } = makeController('countdown');
    await controller.editForCountdown();
    expect(edit).not.toHaveBeenCalled(); // 未投稿
    await controller.post();
    await controller.editForCountdown();
    expect(edit).toHaveBeenCalledWith('m1', expect.anything());
  });

  it('startUpdater は 5秒更新を開始し、discardUpdater で停止する', async () => {
    vi.useFakeTimers();
    const { controller, edit } = makeController('work');
    await controller.post();
    controller.startUpdater();
    // 分境界更新: 十分な時間を進めれば edit が走る。
    await vi.advanceTimersByTimeAsync(65_000);
    const editsWhileRunning = edit.mock.calls.length;
    expect(editsWhileRunning).toBeGreaterThan(0);
    // 破棄後はそれ以上更新されない。
    controller.discardUpdater();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(edit.mock.calls.length).toBe(editsWhileRunning);
  });

  it('stopUpdater は更新を止める (updater 参照は破棄しない)', async () => {
    vi.useFakeTimers();
    const { controller, edit } = makeController('work');
    await controller.post();
    controller.startUpdater();
    controller.stopUpdater();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(edit).not.toHaveBeenCalled();
  });
});
