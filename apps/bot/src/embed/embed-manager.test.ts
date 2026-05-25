import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import {
  EmbedManager,
  shouldHandleHumanMessage,
  type EmbedChannel,
  type PostedMessage,
  type TimerLike,
} from './embed-manager.js';
import type { PhaseSoundNotifier } from './sound-notifier.js';

const config: BotConfig = {
  default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 },
  guildId: 'g',
  voiceChannelId: 'vc',
  adminRoleName: 'pomo-admin',
  adminRoleNames: [],
};

function makeSnapshot(phase: TimerSnapshot['phase']): TimerSnapshot {
  return { phase, remainingMs: 1_000, currentSet: 1, totalSets: 4, startedAt: 0 };
}

type Ev = 'phaseChange' | 'countdown' | 'ended';

class FakeTimer implements TimerLike {
  snapshot: TimerSnapshot = makeSnapshot('idle');
  #listeners = new Map<Ev, ((s: TimerSnapshot) => void)[]>();

  getSnapshot(): TimerSnapshot {
    return this.snapshot;
  }

  on(event: Ev, listener: (s: TimerSnapshot) => void): unknown {
    const arr = this.#listeners.get(event) ?? [];
    arr.push(listener);
    this.#listeners.set(event, arr);
    return this;
  }

  emit(event: Ev, s: TimerSnapshot): void {
    this.snapshot = s;
    for (const l of this.#listeners.get(event) ?? []) {
      l(s);
    }
  }
}

function fakeChannel() {
  let n = 0;
  const post = vi.fn<() => Promise<PostedMessage>>(() => {
    n += 1;
    return Promise.resolve({ id: `m${String(n)}` });
  });
  const edit = vi.fn<(messageId: string, options: unknown) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const del = vi.fn<(messageId: string) => Promise<void>>(() => Promise.resolve());
  const channel: EmbedChannel = { post, edit, delete: del };
  return { channel, post, edit, del };
}

function fakeSound() {
  const playWorkEnd = vi.fn();
  const playBreakEnd = vi.fn();
  const playFinalStart = vi.fn();
  const notifier: PhaseSoundNotifier = { playWorkEnd, playBreakEnd, playFinalStart };
  return { notifier, playWorkEnd, playBreakEnd, playFinalStart };
}

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('shouldHandleHumanMessage', () => {
  it('bot は除外、対象チャンネルのみ true', () => {
    expect(
      shouldHandleHumanMessage({ authorIsBot: false, channelId: 'vc', targetChannelId: 'vc' }),
    ).toBe(true);
    expect(
      shouldHandleHumanMessage({ authorIsBot: true, channelId: 'vc', targetChannelId: 'vc' }),
    ).toBe(false);
    expect(
      shouldHandleHumanMessage({ authorIsBot: false, channelId: 'x', targetChannelId: 'vc' }),
    ).toBe(false);
  });
});

describe('EmbedManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('onIdle はスタート Embed を投稿する', async () => {
    const { channel, post } = fakeChannel();
    const m = new EmbedManager({ channel, timer: new FakeTimer(), config, logger });
    await m.onIdle();
    expect(post).toHaveBeenCalledTimes(1);
    expect(m.startEmbedId).toBe('m1');
  });

  it('onIdle 再実行は既存スタート Embed を削除してから出し直す (冪等)', async () => {
    const { channel, del } = fakeChannel();
    const m = new EmbedManager({ channel, timer: new FakeTimer(), config, logger });
    await m.onIdle(); // m1
    await m.onIdle(); // m1 削除 → m2
    expect(del).toHaveBeenCalledWith('m1');
    expect(m.startEmbedId).toBe('m2');
  });

  it('phaseChange: 初回 work で start削除→timer投稿、work→break で再投稿', async () => {
    const { channel, del } = fakeChannel();
    const timer = new FakeTimer();
    const m = new EmbedManager({ channel, timer, config, logger });
    await m.onIdle(); // m1 = start

    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);
    expect(del).toHaveBeenCalledWith('m1');
    expect(m.timerEmbedId).toBe('m2');

    timer.emit('phaseChange', makeSnapshot('break'));
    await vi.advanceTimersByTimeAsync(0);
    expect(del).toHaveBeenCalledWith('m2');
    expect(m.timerEmbedId).toBe('m3');
  });

  it('onHumanMessage は work 中のみデバウンス→再投稿 (60s)、idle は無視', async () => {
    const { channel, post } = fakeChannel();
    const timer = new FakeTimer();
    const m = new EmbedManager({ channel, timer, config, logger });
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);
    const before = post.mock.calls.length;

    m.onHumanMessage();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(post.mock.calls.length).toBe(before + 1);

    timer.snapshot = makeSnapshot('idle');
    m.onHumanMessage();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(post.mock.calls.length).toBe(before + 1);
  });

  it('countdown で edit、ended で削除→スタート投稿', async () => {
    const { channel, edit, del } = fakeChannel();
    const timer = new FakeTimer();
    const m = new EmbedManager({ channel, timer, config, logger });
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);

    timer.emit('countdown', makeSnapshot('countdown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(edit).toHaveBeenCalled();

    timer.emit('ended', makeSnapshot('ended'));
    await vi.advanceTimersByTimeAsync(0);
    expect(del).toHaveBeenCalled();
    expect(m.startEmbedId).not.toBeNull();
  });
});

describe('EmbedManager.adoptStartEmbed / applyConfig (▶開始結線)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('adoptStartEmbed した外部スタート Embed を初回 work で削除対象にする', async () => {
    const { channel, del } = fakeChannel();
    const timer = new FakeTimer();
    const m = new EmbedManager({ channel, timer, config, logger });
    m.adoptStartEmbed('external-start');
    expect(m.startEmbedId).toBe('external-start');

    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);
    expect(del).toHaveBeenCalledWith('external-start');
    expect(m.startEmbedId).toBeNull();
  });

  it('applyConfig は Discord 通信なしで config を差し替える', () => {
    const { channel, post, edit } = fakeChannel();
    const m = new EmbedManager({ channel, timer: new FakeTimer(), config, logger });
    const next: BotConfig = { ...config, default: { ...config.default, workSec: 60 } };
    m.applyConfig(next);
    expect(post).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });
});

describe('EmbedManager フェーズ切替の通知音 (US-11)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('初回 work は通知音なし、work→break=workEnd、break→work=breakEnd', async () => {
    const { channel } = fakeChannel();
    const timer = new FakeTimer();
    const sound = fakeSound();
    const m = new EmbedManager({
      channel,
      timer,
      config,
      logger,
      soundNotifier: sound.notifier,
    });

    timer.emit('phaseChange', makeSnapshot('work')); // 初回 (idle→work)
    await vi.advanceTimersByTimeAsync(0);
    expect(sound.playWorkEnd).not.toHaveBeenCalled();
    expect(m.timerEmbedId).not.toBeNull();

    timer.emit('phaseChange', makeSnapshot('break')); // work→break
    await vi.advanceTimersByTimeAsync(0);
    expect(sound.playWorkEnd).toHaveBeenCalledTimes(1);

    timer.emit('phaseChange', makeSnapshot('work')); // break→work
    await vi.advanceTimersByTimeAsync(0);
    expect(sound.playBreakEnd).toHaveBeenCalledTimes(1);
  });

  it('work→finalBreak で finalStart を鳴らし再投稿後も 5秒更新が続く', async () => {
    const { channel, edit } = fakeChannel();
    const timer = new FakeTimer();
    const sound = fakeSound();
    const m = new EmbedManager({
      channel,
      timer,
      config,
      logger,
      soundNotifier: sound.notifier,
    });

    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);

    timer.snapshot = makeSnapshot('finalBreak');
    timer.emit('phaseChange', makeSnapshot('finalBreak'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sound.playFinalStart).toHaveBeenCalledTimes(1);
    expect(m.timerEmbedId).not.toBeNull();

    const before = edit.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(edit.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('EmbedManager.updateStartEmbed (US-12)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('startEmbed を新 config で edit する', async () => {
    const { channel, edit } = fakeChannel();
    const m = new EmbedManager({ channel, timer: new FakeTimer(), config, logger });
    await m.onIdle(); // startEmbedId = m1

    const newConfig: BotConfig = {
      ...config,
      default: { ...config.default, workSec: 3000 },
    };
    await m.updateStartEmbed(newConfig);

    expect(edit).toHaveBeenCalled();
    expect(edit.mock.calls[0]?.[0]).toBe('m1');
  });

  it('startEmbed 未投稿なら edit しない', async () => {
    const { channel, edit } = fakeChannel();
    const m = new EmbedManager({ channel, timer: new FakeTimer(), config, logger });
    await m.updateStartEmbed(config);
    expect(edit).not.toHaveBeenCalled();
  });
});
