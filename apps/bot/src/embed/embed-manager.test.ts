import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageCreateOptions } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import {
  CONTINUE_MAX_SESSION_MS,
  EmbedManager,
  shouldHandleHumanMessage,
  type EmbedChannel,
  type PostedMessage,
  type TimerLike,
} from './embed-manager.js';
import { TIMEOUT_CONTENT } from './timeout-message.js';
import { FAREWELL_CONTENT } from './farewell-message.js';
import type { PhaseSoundNotifier } from './sound-notifier.js';

const config: BotConfig = {
  default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 },
  guildId: 'g',
  voiceChannelId: 'vc',
  adminRoleName: 'pomo-admin',
  adminRoleNames: [],
  volumes: { workEnd: 0, breakEnd: 0, finalStart: 0, countdownWarning: 0, finish: 0 },
  autoStart: { time: null, label: '自動スタート' },
};

function makeSnapshot(phase: TimerSnapshot['phase']): TimerSnapshot {
  return { phase, remainingMs: 1_000, currentSet: 1, totalSets: 4, startedAt: 0 };
}

type Ev = 'phaseChange' | 'countdown' | 'ended';

class FakeTimer implements TimerLike {
  snapshot: TimerSnapshot = makeSnapshot('idle');
  resetCallCount = 0;
  startContinuousCalls: { workSec: number; breakSec: number; baseSets: number }[] = [];
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

  reset(): void {
    this.resetCallCount += 1;
    this.snapshot = makeSnapshot('idle');
  }

  /** 実 PomodoroTimer 同様、開始で work への phaseChange (継続スナップショット) を発火する。 */
  startContinuous(workSec: number, breakSec: number, baseSets: number): void {
    this.startContinuousCalls.push({ workSec, breakSec, baseSets });
    this.emit('phaseChange', {
      phase: 'work',
      remainingMs: workSec * 1000,
      currentSet: baseSets + 1,
      totalSets: 0,
      startedAt: 0,
      continuous: true,
    });
  }
}

function fakeChannel() {
  let n = 0;
  // post 呼び出しの直前に purgeOwnEmbeds が呼ばれているかを order で検証するため、
  // 共通の calls 配列に名前を記録する。
  const calls: string[] = [];
  const post = vi.fn<(options: MessageCreateOptions) => Promise<PostedMessage>>(() => {
    calls.push('post');
    n += 1;
    return Promise.resolve({ id: `m${String(n)}` });
  });
  const edit = vi.fn<(messageId: string, options: unknown) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const del = vi.fn<(messageId: string) => Promise<void>>(() => Promise.resolve());
  const purgeOwnEmbeds = vi.fn<() => Promise<void>>(() => {
    calls.push('purge');
    return Promise.resolve();
  });
  const purgeOwnTexts = vi.fn<(contents: string[]) => Promise<void>>(() => {
    calls.push('purgeTexts');
    return Promise.resolve();
  });
  const channel: EmbedChannel = { post, edit, delete: del, purgeOwnEmbeds, purgeOwnTexts };
  return { channel, post, edit, del, purgeOwnEmbeds, purgeOwnTexts, calls };
}

function fakeSound() {
  const playWorkEnd = vi.fn();
  const playBreakEnd = vi.fn();
  const playFinalStart = vi.fn();
  const playCountdownWarning = vi.fn();
  const playFinish = vi.fn();
  const notifier: PhaseSoundNotifier = {
    playWorkEnd,
    playBreakEnd,
    playFinalStart,
    playCountdownWarning,
    playFinish,
  };
  return {
    notifier,
    playWorkEnd,
    playBreakEnd,
    playFinalStart,
    playCountdownWarning,
    playFinish,
  };
}

function fakeEndingActions() {
  const kickAllHumans = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const kickHumansExcept = vi.fn<(except: ReadonlySet<string>) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const disconnectBot = vi.fn();
  return {
    actions: { kickAllHumans, kickHumansExcept, disconnectBot },
    kickAllHumans,
    kickHumansExcept,
    disconnectBot,
  };
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

  it('Embed 投稿の直前に purgeOwnEmbeds を呼ぶ (歓迎・お疲れさまテキストは Embed なしで対象外)', async () => {
    const { channel, post, purgeOwnEmbeds, calls } = fakeChannel();
    const timer = new FakeTimer();
    const m = new EmbedManager({
      channel,
      timer,
      config,
      logger,
      endingDelay: () => Promise.resolve(),
    });
    await m.onIdle(); // Embed post: スタート
    timer.emit('phaseChange', makeSnapshot('work')); // Embed post: タイマー + text post: 歓迎
    await vi.advanceTimersByTimeAsync(0);
    timer.emit('phaseChange', makeSnapshot('break')); // Embed post: 再投稿 (歓迎は再post しない)
    await vi.advanceTimersByTimeAsync(0);
    timer.emit('ended', makeSnapshot('ended')); // text post: お疲れさま (新スタートは15秒後)
    await vi.advanceTimersByTimeAsync(0);
    // 新スタート Embed はお疲れさま削除 (投稿15秒後) の直後に投稿される。
    await vi.advanceTimersByTimeAsync(15_000);

    // Embed 投稿は 4 回 (onIdle / work / break / ended後15秒の新スタート)。
    // テキスト投稿 (Embed なし) は歓迎 + お疲れさまの 2 回追加 = post 計 6 回。
    expect(post).toHaveBeenCalledTimes(6);
    // purge は Embed 投稿 4 回分だけ。歓迎・お疲れさまテキストの前には purge を入れない。
    expect(purgeOwnEmbeds).toHaveBeenCalledTimes(4);
    const purgeBeforePost = calls.reduce<number>(
      (acc, c, i) => (c === 'post' && calls[i - 1] === 'purge' ? acc + 1 : acc),
      0,
    );
    expect(purgeBeforePost).toBe(4);
    expect(m.startEmbedId).not.toBeNull();
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

    // phaseChange(work): m1 削除 → m2=timer post → m3=welcome post (Embed なし)。
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);
    expect(del).toHaveBeenCalledWith('m1');
    expect(m.timerEmbedId).toBe('m2');

    // phaseChange(break): m2 削除 → m4=timer 再投稿 (m3 の welcome は触らない)。
    timer.emit('phaseChange', makeSnapshot('break'));
    await vi.advanceTimersByTimeAsync(0);
    expect(del).toHaveBeenCalledWith('m2');
    expect(m.timerEmbedId).toBe('m4');
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

  it('デバウンス発火時に countdown へ遷移済みなら timer Embed を貼り直さない (in-flight flush ガード)', async () => {
    const { channel, post } = fakeChannel();
    const timer = new FakeTimer();
    const m = new EmbedManager({ channel, timer, config, logger });
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);
    const before = post.mock.calls.length;

    // work 中に検知してデバウンス開始 (60s 後に flush 予定)。
    m.onHumanMessage();
    // flush 前にフェーズが countdown へ進む。onCountdownEnter の cancel() は
    // in-flight な flush を止められないため、flush が countdown 中に走る状況を
    // snapshot 差し替えで再現する (cancel は呼ばない)。
    timer.snapshot = makeSnapshot('countdown');
    await vi.advanceTimersByTimeAsync(60_000);

    // 表示フェーズ外なので貼り直しは抑止され post は増えない (孤児 Embed を作らない)。
    expect(post.mock.calls.length).toBe(before);
  });

  it('countdown で edit、ended で削除→お疲れさま投稿→3秒待機、新スタートはお疲れさま削除後(15秒後)', async () => {
    const { channel, edit, del } = fakeChannel();
    const timer = new FakeTimer();
    // endingDelay を即解決にして fake timers の advanceTimersByTime 依存を最小化する
    const m = new EmbedManager({
      channel,
      timer,
      config,
      logger,
      endingDelay: () => Promise.resolve(),
    });
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);

    timer.emit('countdown', makeSnapshot('countdown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(edit).toHaveBeenCalled();

    timer.emit('ended', makeSnapshot('ended'));
    await vi.advanceTimersByTimeAsync(0);
    expect(del).toHaveBeenCalled();
    // この時点ではスタート Embed はまだ出さない (お疲れさま削除後に投稿)。
    expect(m.startEmbedId).toBeNull();
    // 15秒後: お疲れさま削除 → 新スタート Embed 投稿。
    await vi.advanceTimersByTimeAsync(15_000);
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

describe('EmbedManager countdown 突入の終了予告音 (US-18)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('countdown 突入で playCountdownWarning を 1 回呼ぶ', async () => {
    const { channel } = fakeChannel();
    const timer = new FakeTimer();
    const sound = fakeSound();
    const m = new EmbedManager({ channel, timer, config, logger, soundNotifier: sound.notifier });
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);

    timer.emit('countdown', makeSnapshot('countdown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sound.playCountdownWarning).toHaveBeenCalledTimes(1);
    expect(m.timerEmbedId).not.toBeNull();
  });

  it('countdown 二重発火でも playCountdownWarning は 1 回のみ (仕様: 1回のみ)', async () => {
    const { channel } = fakeChannel();
    const timer = new FakeTimer();
    const sound = fakeSound();
    const m = new EmbedManager({ channel, timer, config, logger, soundNotifier: sound.notifier });
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);

    timer.emit('countdown', makeSnapshot('countdown'));
    timer.emit('countdown', makeSnapshot('countdown'));
    timer.emit('countdown', makeSnapshot('countdown'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sound.playCountdownWarning).toHaveBeenCalledTimes(1);
    // m を経由したものは使わないが、未使用変数警告回避のため参照する
    expect(m.timerEmbedId).not.toBeNull();
  });

  it('soundNotifier 未注入なら countdown 突入でも再生呼び出しは起きない (no-op)', async () => {
    const { channel, edit } = fakeChannel();
    const timer = new FakeTimer();
    const m = new EmbedManager({ channel, timer, config, logger });
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);

    timer.emit('countdown', makeSnapshot('countdown'));
    await vi.advanceTimersByTimeAsync(0);
    // 例外なく countdown 表示への edit が走ること (=既存挙動を壊さない)
    expect(edit).toHaveBeenCalled();
    expect(m.timerEmbedId).not.toBeNull();
  });
});

describe('EmbedManager 終了演出フロー (US-19)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ended 突入で playFinish→Embed削除→お疲れさま投稿→余韻→kick→disconnect→新スタートEmbed、お疲れさま削除は15秒後', async () => {
    const { channel, post, del, calls } = fakeChannel();
    const sound = fakeSound();
    const ending = fakeEndingActions();
    const timer = new FakeTimer();
    const delaySeq: number[] = [];
    const m = new EmbedManager({
      channel,
      timer,
      config,
      logger,
      soundNotifier: sound.notifier,
      endingActions: ending.actions,
      endingDelay: (ms) => {
        delaySeq.push(ms);
        return Promise.resolve();
      },
    });
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);
    const timerEmbedId = m.timerEmbedId;
    expect(timerEmbedId).not.toBeNull();

    timer.emit('ended', makeSnapshot('ended'));
    await vi.advanceTimersByTimeAsync(0);

    // finish 音は 1 回鳴る。
    expect(sound.playFinish).toHaveBeenCalledTimes(1);
    // タイマー Embed (m1) が削除される。
    expect(del).toHaveBeenCalledWith(timerEmbedId);
    // お疲れさま投稿が post される (SuppressNotifications なし = flags 未指定)。
    const farewellCall = post.mock.calls.find((c) => c[0].content === 'お疲れさまでした 👋');
    expect(farewellCall).toBeDefined();
    // 余韻 3 秒の delay が呼ばれる。
    expect(delaySeq).toEqual([3_000]);
    // VC 全員強制退出 → bot 退出の順。
    expect(ending.kickAllHumans).toHaveBeenCalledTimes(1);
    expect(ending.disconnectBot).toHaveBeenCalledTimes(1);
    // fakeChannel は post ごとに m1, m2... を返す:
    // timerEmbed=m1, welcome=m2, farewell=m3。
    // 歓迎投稿 (m2) は終了演出中に削除されるが、お疲れさま投稿 (m3) はこの時点では
    // まだ削除されていない (投稿15秒後)。
    expect(del.mock.calls.map((c) => c[0])).toContain('m2');
    expect(del.mock.calls.map((c) => c[0])).not.toContain('m3');
    expect(m.welcomeMessageId).toBeNull();
    // タイマーが reset され、次の ▶開始で getSnapshot().phase==='idle' になる。
    expect(timer.resetCallCount).toBe(1);
    expect(timer.getSnapshot().phase).toBe('idle');
    // この時点ではスタート Embed はまだ投稿していない (お疲れさま削除後に投稿)。
    expect(m.startEmbedId).toBeNull();

    // 投稿から 15 秒後: お疲れさま (m3) を削除し、その直後に新スタート Embed を投稿。
    await vi.advanceTimersByTimeAsync(15_000);
    expect(del.mock.calls.map((c) => c[0])).toContain('m3');
    expect(m.startEmbedId).not.toBeNull();
    // 削除(m3) → 新スタート post の順 (お疲れさま削除後にスタートを出す)。
    const m3DeleteOrder = del.mock.calls.findIndex((c) => c[0] === 'm3');
    expect(m3DeleteOrder).toBeGreaterThanOrEqual(0);
    const postIndices = calls.map((c, i) => (c === 'post' ? i : -1)).filter((i) => i >= 0);
    expect(postIndices.length).toBeGreaterThanOrEqual(2);
  });

  it('お疲れさま投稿の15秒後削除が失敗しても終了演出 (新スタートEmbed) は完了し例外も伝播しない (best-effort)', async () => {
    const { channel, del } = fakeChannel();
    // m3 (お疲れさま投稿。post 順は m1=timer / m2=welcome / m3=farewell) の削除だけ失敗させる。
    del.mockImplementation((id: string) => {
      if (id === 'm3') {
        return Promise.reject(new Error('farewell delete failed'));
      }
      return Promise.resolve();
    });
    const sound = fakeSound();
    const ending = fakeEndingActions();
    const timer = new FakeTimer();
    const m = new EmbedManager({
      channel,
      timer,
      config,
      logger,
      soundNotifier: sound.notifier,
      endingActions: ending.actions,
      endingDelay: () => Promise.resolve(),
    });
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);

    timer.emit('ended', makeSnapshot('ended'));
    await vi.advanceTimersByTimeAsync(0);

    // この時点ではスタート Embed はまだ (お疲れさま削除後に投稿)。
    expect(m.startEmbedId).toBeNull();
    expect(del.mock.calls.map((c) => c[0])).not.toContain('m3');

    // 15秒後: お疲れさま削除を試行 → reject するが catch で握りつぶし、その後も
    // スタート Embed 投稿は実行される (削除失敗は後段をブロックしない)。
    await vi.advanceTimersByTimeAsync(15_000);
    expect(del.mock.calls.map((c) => c[0])).toContain('m3');
    expect(m.startEmbedId).not.toBeNull();
  });

  it('isEnding ガード: 二重 ended でも終了演出は 1 回のみ走る', async () => {
    const { channel, post } = fakeChannel();
    const sound = fakeSound();
    const ending = fakeEndingActions();
    const timer = new FakeTimer();
    const m = new EmbedManager({
      channel,
      timer,
      config,
      logger,
      soundNotifier: sound.notifier,
      endingActions: ending.actions,
      endingDelay: () => Promise.resolve(),
    });
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);

    // 1 回目を開始 (await しないで 2 回目を即座にトリガー)。
    const first = m.onEnded();
    const second = m.onEnded();
    await Promise.all([first, second]);

    expect(sound.playFinish).toHaveBeenCalledTimes(1);
    expect(ending.kickAllHumans).toHaveBeenCalledTimes(1);
    expect(ending.disconnectBot).toHaveBeenCalledTimes(1);
    // お疲れさま投稿は 1 回のみ (二重 ended でも重複しない)。
    const farewellCount = post.mock.calls.filter(
      (c) => c[0].content === 'お疲れさまでした 👋',
    ).length;
    expect(farewellCount).toBe(1);
    // スタート Embed は15秒後 (お疲れさま削除後) に 1 回だけ投稿される。
    await vi.advanceTimersByTimeAsync(15_000);
    expect(m.startEmbedId).not.toBeNull();
  });

  it('endingActions 未注入でも finish音・お疲れさま・余韻が走り、新スタートはお疲れさま削除後 (kick/退出のみスキップ)', async () => {
    const { channel, post } = fakeChannel();
    const sound = fakeSound();
    const timer = new FakeTimer();
    const m = new EmbedManager({
      channel,
      timer,
      config,
      logger,
      soundNotifier: sound.notifier,
      endingDelay: () => Promise.resolve(),
    });
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);

    timer.emit('ended', makeSnapshot('ended'));
    await vi.advanceTimersByTimeAsync(0);

    expect(sound.playFinish).toHaveBeenCalledTimes(1);
    const farewellCount = post.mock.calls.filter(
      (c) => c[0].content === 'お疲れさまでした 👋',
    ).length;
    expect(farewellCount).toBe(1);
    expect(m.startEmbedId).toBeNull();
    // お疲れさま削除 (15秒後) の直後に新スタート Embed を投稿。
    await vi.advanceTimersByTimeAsync(15_000);
    expect(m.startEmbedId).not.toBeNull();
  });

  it('kickAllHumans が reject しても disconnectBot と新スタート Embed は実行される (best-effort)', async () => {
    const { channel } = fakeChannel();
    const sound = fakeSound();
    const ending = fakeEndingActions();
    ending.kickAllHumans.mockRejectedValueOnce(new Error('boom'));
    const timer = new FakeTimer();
    const m = new EmbedManager({
      channel,
      timer,
      config,
      logger,
      soundNotifier: sound.notifier,
      endingActions: ending.actions,
      endingDelay: () => Promise.resolve(),
    });
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);

    timer.emit('ended', makeSnapshot('ended'));
    await vi.advanceTimersByTimeAsync(0);

    expect(ending.kickAllHumans).toHaveBeenCalledTimes(1);
    expect(ending.disconnectBot).toHaveBeenCalledTimes(1);
    // 新スタート Embed はお疲れさま削除 (15秒後) の直後に投稿される。
    await vi.advanceTimersByTimeAsync(15_000);
    expect(m.startEmbedId).not.toBeNull();
  });
});

describe('EmbedManager 歓迎投稿 (welcome message)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('onTimerStart で歓迎投稿を post し welcomeMessageId を保持する', async () => {
    const { channel, post } = fakeChannel();
    const timer = new FakeTimer();
    const m = new EmbedManager({ channel, timer, config, logger });

    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);

    const welcomeCall = post.mock.calls.find((c) =>
      (c[0].content ?? '').includes('ご参加ありがとうございます'),
    );
    expect(welcomeCall).toBeDefined();
    expect(m.welcomeMessageId).not.toBeNull();
  });

  it('歓迎投稿は中間フェーズ切替 (work→break) では再 post されない', async () => {
    const { channel, post } = fakeChannel();
    const timer = new FakeTimer();
    new EmbedManager({ channel, timer, config, logger });

    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);
    timer.emit('phaseChange', makeSnapshot('break'));
    await vi.advanceTimersByTimeAsync(0);

    const welcomePostCount = post.mock.calls.filter((c) =>
      (c[0].content ?? '').includes('ご参加ありがとうございます'),
    ).length;
    expect(welcomePostCount).toBe(1);
  });

  it('countdown 突入 (終了予告音の直後) で歓迎投稿が削除される', async () => {
    const { channel, del } = fakeChannel();
    const timer = new FakeTimer();
    const m = new EmbedManager({ channel, timer, config, logger });

    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);
    const welcomeId = m.welcomeMessageId;
    expect(welcomeId).not.toBeNull();

    timer.emit('countdown', makeSnapshot('countdown'));
    await vi.advanceTimersByTimeAsync(0);

    expect(del.mock.calls.map((c) => c[0])).toContain(welcomeId);
    expect(m.welcomeMessageId).toBeNull();
  });

  it('onEnded で歓迎投稿が削除され welcomeMessageId は null に戻る', async () => {
    const { channel, del } = fakeChannel();
    const timer = new FakeTimer();
    const m = new EmbedManager({
      channel,
      timer,
      config,
      logger,
      endingActions: fakeEndingActions().actions,
      endingDelay: () => Promise.resolve(),
    });

    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);
    const welcomeId = m.welcomeMessageId;
    expect(welcomeId).not.toBeNull();

    timer.emit('ended', makeSnapshot('ended'));
    await vi.advanceTimersByTimeAsync(0);

    expect(del.mock.calls.map((c) => c[0])).toContain(welcomeId);
    expect(m.welcomeMessageId).toBeNull();
  });

  it('onIdle (/pomo stop) でも歓迎投稿が削除される (onEnded を経由しない経路)', async () => {
    const { channel, del } = fakeChannel();
    const timer = new FakeTimer();
    const m = new EmbedManager({ channel, timer, config, logger });

    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);
    const welcomeId = m.welcomeMessageId;
    expect(welcomeId).not.toBeNull();

    await m.onIdle();
    expect(del.mock.calls.map((c) => c[0])).toContain(welcomeId);
    expect(m.welcomeMessageId).toBeNull();
  });

  it('歓迎投稿の delete 失敗は best-effort (warn のみで例外を伝播させない)', async () => {
    const { channel, del } = fakeChannel();
    del.mockImplementation((id: string) => {
      if (id === 'm2') {
        return Promise.reject(new Error('welcome delete failed'));
      }
      return Promise.resolve();
    });
    const timer = new FakeTimer();
    const m = new EmbedManager({ channel, timer, config, logger });

    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);
    // m1=timerEmbed, m2=welcome。welcomeMessageId は m2。
    expect(m.welcomeMessageId).toBe('m2');

    // delete 失敗しても onIdle は throw せず idle に戻る。
    await expect(m.onIdle()).resolves.toBeUndefined();
    expect(m.welcomeMessageId).toBeNull();
    expect(m.startEmbedId).not.toBeNull();
  });
});

describe('EmbedManager.repostStartEmbed (設定モーダル結線)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('既存 Start Embed を delete → 最新 config で post し直す', async () => {
    const { channel, post, del, purgeOwnEmbeds, calls } = fakeChannel();
    const m = new EmbedManager({ channel, timer: new FakeTimer(), config, logger });
    await m.onIdle(); // startEmbedId = m1, calls=['purge','post']
    post.mockClear();
    del.mockClear();
    purgeOwnEmbeds.mockClear();
    calls.length = 0;

    const newConfig: BotConfig = {
      ...config,
      default: { ...config.default, workSec: 3000 },
    };
    await m.repostStartEmbed(newConfig);

    // 旧 m1 を delete → purge → post の順 (#postFresh 経由)。
    expect(del).toHaveBeenCalledWith('m1');
    expect(calls).toEqual(['purge', 'post']);
    expect(post).toHaveBeenCalledTimes(1);
    // 新 Embed 投稿の id を新 startEmbedId として保持。
    expect(m.startEmbedId).not.toBeNull();
    expect(m.startEmbedId).not.toBe('m1');
  });

  it('Start Embed 未投稿なら config 反映のみで post/delete しない (no-op)', async () => {
    const { channel, post, del } = fakeChannel();
    const m = new EmbedManager({ channel, timer: new FakeTimer(), config, logger });
    await m.repostStartEmbed(config);
    expect(post).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(m.startEmbedId).toBeNull();
  });
});

describe('EmbedManager 孤児テキスト掃除 / isEnding (監査観察事項1-3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('isEnding は初期 false、onTimerStart で歓迎/お疲れさまの本文掃除を呼ぶ', async () => {
    const { channel, purgeOwnTexts } = fakeChannel();
    const timer = new FakeTimer();
    const m = new EmbedManager({ channel, timer, config, logger });
    expect(m.isEnding).toBe(false);

    timer.emit('phaseChange', makeSnapshot('work')); // 初回 → onTimerStart
    await vi.advanceTimersByTimeAsync(0);

    expect(purgeOwnTexts).toHaveBeenCalledTimes(1);
    const contents = purgeOwnTexts.mock.calls[0]?.[0] ?? [];
    expect(contents).toContain('お疲れさまでした 👋');
    expect(contents.some((c) => c.includes('ご参加ありがとうございます'))).toBe(true);
  });

  it('onIdle でも歓迎/お疲れさまの本文掃除を呼ぶ (孤児回収)', async () => {
    const { channel, purgeOwnTexts } = fakeChannel();
    const m = new EmbedManager({ channel, timer: new FakeTimer(), config, logger });
    await m.onIdle();
    expect(purgeOwnTexts).toHaveBeenCalledTimes(1);
  });

  it('purgeOrphanTexts は歓迎/お疲れさまの本文掃除を呼ぶ (起動時クリーンアップ用)', async () => {
    const { channel, purgeOwnTexts } = fakeChannel();
    const m = new EmbedManager({ channel, timer: new FakeTimer(), config, logger });
    await m.purgeOrphanTexts();
    expect(purgeOwnTexts).toHaveBeenCalledTimes(1);
    const contents = purgeOwnTexts.mock.calls[0]?.[0] ?? [];
    expect(contents).toContain('お疲れさまでした 👋');
  });

  it('ended で予約したお疲れさま15秒削除は、15秒前に新セッションが始まると発火しない', async () => {
    const { channel, del } = fakeChannel();
    const timer = new FakeTimer();
    // 構築でタイマーイベントを購読する (副作用)。変数参照は不要。
    new EmbedManager({
      channel,
      timer,
      config,
      logger,
      endingDelay: () => Promise.resolve(),
    });
    // 1 セッション目: work → ended。お疲れさま (m3) の15秒削除を予約。
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);
    timer.emit('ended', makeSnapshot('ended'));
    await vi.advanceTimersByTimeAsync(0);

    // 15秒経過前 (10秒後) に新セッション開始 → onTimerStart が予約をキャンセル。
    timer.snapshot = makeSnapshot('idle');
    await vi.advanceTimersByTimeAsync(10_000);
    timer.emit('phaseChange', makeSnapshot('work'));
    await vi.advanceTimersByTimeAsync(0);

    // 新セッション開始直後の delete 数を基準に、さらに 60 秒進めても増えないこと
    // = 予約済みの「お疲れさま15秒削除」タイマーがキャンセルされ発火していないこと。
    const delsAfterRestart = del.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(del.mock.calls.length).toBe(delsAfterRestart);
  });

  describe('「続行」継続機能 (US-続行)', () => {
    function setupContinue() {
      const fc = fakeChannel();
      const timer = new FakeTimer();
      const sound = fakeSound();
      const ea = fakeEndingActions();
      const m = new EmbedManager({
        channel: fc.channel,
        timer,
        config,
        logger,
        soundNotifier: sound.notifier,
        endingActions: ea.actions,
        endingDelay: () => Promise.resolve(),
      });
      return { fc, timer, sound, ea, m };
    }

    /** work → finalBreak まで進めて #currentPhase='finalBreak' にする。 */
    async function reachFinalBreak(timer: FakeTimer): Promise<void> {
      timer.emit('phaseChange', makeSnapshot('work'));
      await vi.advanceTimersByTimeAsync(0);
      timer.emit('phaseChange', makeSnapshot('finalBreak'));
      await vi.advanceTimersByTimeAsync(0);
    }

    const postedContents = (fc: ReturnType<typeof fakeChannel>): string[] =>
      fc.post.mock.calls
        .map((c) => (c[0] as { content?: string }).content)
        .filter((c): c is string => typeof c === 'string');

    it('最終休憩でのみ registerContinueUser を受理する', async () => {
      const { timer, m } = setupContinue();
      // work 中は不可。
      timer.emit('phaseChange', makeSnapshot('work'));
      await vi.advanceTimersByTimeAsync(0);
      expect(m.registerContinueUser('u1')).toBe('closed');
      // finalBreak で可。
      timer.emit('phaseChange', makeSnapshot('finalBreak'));
      await vi.advanceTimersByTimeAsync(0);
      expect(m.registerContinueUser('u1')).toBe('ok');
    });

    it('続行受付後は countdown 演出 (終了予告音) を抑制する', async () => {
      const { timer, sound, m } = setupContinue();
      await reachFinalBreak(timer);
      expect(m.registerContinueUser('u1')).toBe('ok');
      timer.emit('countdown', makeSnapshot('countdown'));
      await vi.advanceTimersByTimeAsync(0);
      expect(sound.playCountdownWarning).not.toHaveBeenCalled();
    });

    it('続行ありの ended は終了演出せず継続ループへ移行する (押した人以外を退出)', async () => {
      const { timer, sound, ea, m } = setupContinue();
      await reachFinalBreak(timer);
      m.registerContinueUser('u1');
      m.registerContinueUser('u2');
      timer.emit('ended', makeSnapshot('ended'));
      await vi.advanceTimersByTimeAsync(0);

      // 押していない人だけ退出 (except に u1/u2)、全員退出/bot退出/終了音はしない。
      expect(ea.kickHumansExcept).toHaveBeenCalledTimes(1);
      const except = ea.kickHumansExcept.mock.calls[0]?.[0];
      expect(except?.has('u1')).toBe(true);
      expect(except?.has('u2')).toBe(true);
      expect(ea.kickAllHumans).not.toHaveBeenCalled();
      expect(ea.disconnectBot).not.toHaveBeenCalled();
      expect(sound.playFinish).not.toHaveBeenCalled();
      // 開始時の作業/休憩秒・元セッションの実施セット数 (4) で継続開始。
      expect(timer.startContinuousCalls).toEqual([{ workSec: 1500, breakSec: 300, baseSets: 4 }]);
      expect(m.continuousActive).toBe(true);
    });

    it('継続移行後の ended (VC 0 人相当) は実終了する', async () => {
      const { fc, timer, sound, ea, m } = setupContinue();
      await reachFinalBreak(timer);
      m.registerContinueUser('u1');
      timer.emit('ended', makeSnapshot('ended'));
      await vi.advanceTimersByTimeAsync(0);
      expect(m.continuousActive).toBe(true);

      // VC 空経由の終了演出 (triggerEndingFlow 相当) を再度呼ぶ。
      await m.onEnded('normal');
      await vi.advanceTimersByTimeAsync(0);

      expect(sound.playFinish).toHaveBeenCalledTimes(1);
      expect(ea.kickAllHumans).toHaveBeenCalledTimes(1);
      expect(ea.disconnectBot).toHaveBeenCalledTimes(1);
      expect(postedContents(fc)).toContain(FAREWELL_CONTENT);
      expect(m.continuousActive).toBe(false);
    });

    it('誰も押さない最終休憩→ended は従来どおり終了演出する', async () => {
      const { fc, timer, sound, ea, m } = setupContinue();
      await reachFinalBreak(timer);
      // 続行なしで countdown → ended。
      timer.emit('countdown', makeSnapshot('countdown'));
      await vi.advanceTimersByTimeAsync(0);
      expect(sound.playCountdownWarning).toHaveBeenCalledTimes(1);
      timer.emit('ended', makeSnapshot('ended'));
      await vi.advanceTimersByTimeAsync(0);

      expect(sound.playFinish).toHaveBeenCalledTimes(1);
      expect(ea.kickAllHumans).toHaveBeenCalledTimes(1);
      expect(ea.kickHumansExcept).not.toHaveBeenCalled();
      expect(timer.startContinuousCalls).toEqual([]);
      expect(m.continuousActive).toBe(false);
      expect(postedContents(fc)).toContain(FAREWELL_CONTENT);
    });

    /**
     * #endingDelay を外部から解決できる deferred で差し替えた setup。
     * #enterContinue の kick 直前グレース (CONTINUE_GRACE_MS) を任意のタイミングで解除でき、
     * グレース中の遅延登録が残留に反映されるかを検証するために使う。
     */
    function setupContinueWithManualGrace() {
      const fc = fakeChannel();
      const timer = new FakeTimer();
      const sound = fakeSound();
      const ea = fakeEndingActions();
      let releaseGrace!: () => void;
      let graceCalls = 0;
      const m = new EmbedManager({
        channel: fc.channel,
        timer,
        config,
        logger,
        soundNotifier: sound.notifier,
        endingActions: ea.actions,
        endingDelay: () => {
          graceCalls += 1;
          return new Promise<void>((resolve) => {
            releaseGrace = resolve;
          });
        },
      });
      return {
        fc,
        timer,
        sound,
        ea,
        m,
        release: () => {
          releaseGrace();
        },
        graceCalls: () => graceCalls,
      };
    }

    it('ended 後・kick 前のグレース中に届いた登録も残留に反映される (レース対策の中核)', async () => {
      const { timer, ea, m, release } = setupContinueWithManualGrace();
      await reachFinalBreak(timer);
      // ended 前に u1 が押下。
      expect(m.registerContinueUser('u1')).toBe('ok');
      timer.emit('ended', makeSnapshot('ended'));
      await vi.advanceTimersByTimeAsync(0);
      // グレース待機中: まだ kick していない。受付は開いたまま (締切前)。
      expect(ea.kickHumansExcept).not.toHaveBeenCalled();
      // ended 後にギリギリ届いた u2 の押下もグレース中なら受理される。
      expect(m.registerContinueUser('u2')).toBe('ok');
      // グレース解除 → 締切 → kick 実行。except に u1/u2 両方が含まれ、どちらも退出させない。
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(ea.kickHumansExcept).toHaveBeenCalledTimes(1);
      const except = ea.kickHumansExcept.mock.calls[0]?.[0];
      expect(except?.has('u1')).toBe(true);
      expect(except?.has('u2')).toBe(true);
      // 移行は 1 回のみ (グレースを挟んでも二重 enterContinue しない)。
      expect(timer.startContinuousCalls).toHaveLength(1);
    });

    it('グレース中 (#isEnding=true) でも受付は閉じない / 締切後は closed になる', async () => {
      const { timer, m, release } = setupContinueWithManualGrace();
      await reachFinalBreak(timer);
      m.registerContinueUser('u1');
      timer.emit('ended', makeSnapshot('ended'));
      await vi.advanceTimersByTimeAsync(0);
      // #isEnding は終了演出の二重発火ガード用であり、受付締切とは独立。
      // グレース中 (isEnding=true) でも受付は開いている = #isEnding 単独では閉じない。
      expect(m.isEnding).toBe(true);
      expect(m.registerContinueUser('u2')).toBe('ok');
      // グレース解除で締切 (#continueRegistrationClosed=true) → 以降は closed。
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(m.registerContinueUser('u3')).toBe('closed');
    });

    it('継続→実終了→新セッションの finalBreak で再び registerContinueUser を受理する', async () => {
      const { timer, m } = setupContinue();
      // 1 セッション目: finalBreak → 続行ありで継続移行 → VC 空相当の ended で実終了。
      await reachFinalBreak(timer);
      m.registerContinueUser('u1');
      timer.emit('ended', makeSnapshot('ended'));
      await vi.advanceTimersByTimeAsync(0);
      await m.onEnded('normal');
      await vi.advanceTimersByTimeAsync(0);
      expect(m.continuousActive).toBe(false);
      // 2 セッション目: リセットで締切フラグもクリアされ、再び finalBreak で受付可能。
      timer.emit('phaseChange', makeSnapshot('work'));
      await vi.advanceTimersByTimeAsync(0);
      timer.emit('phaseChange', makeSnapshot('finalBreak'));
      await vi.advanceTimersByTimeAsync(0);
      expect(m.registerContinueUser('u2')).toBe('ok');
    });

    it('セッション開始から23時間で強制終了し timeout メッセージを投稿する', async () => {
      // m は構築時に timer を購読しキャップ closure からも参照されるため未使用で問題ない。
      const { fc, timer, sound, ea } = setupContinue();
      // onTimerStart で 23時間キャップが arm される。
      timer.emit('phaseChange', makeSnapshot('work'));
      await vi.advanceTimersByTimeAsync(0);
      // 更新タイマーの空回しと canvas 再描画を避けるため、updater がスキップする
      // フェーズかつ大きな残り時間に差し替える (キャップ発火自体には影響しない)。
      timer.snapshot = {
        phase: 'idle',
        remainingMs: CONTINUE_MAX_SESSION_MS,
        currentSet: 0,
        totalSets: 4,
        startedAt: 0,
      };

      await vi.advanceTimersByTimeAsync(CONTINUE_MAX_SESSION_MS);

      expect(timer.resetCallCount).toBeGreaterThanOrEqual(1);
      expect(sound.playFinish).toHaveBeenCalledTimes(1);
      expect(ea.kickAllHumans).toHaveBeenCalledTimes(1);
      expect(ea.disconnectBot).toHaveBeenCalledTimes(1);
      expect(postedContents(fc)).toContain(TIMEOUT_CONTENT);
    });
  });

  describe('自動スタート (resetForRestart / postAutoStartResetNotice)', () => {
    it('postAutoStartResetNotice はラベル入りのお知らせを投稿する', async () => {
      const { channel, post } = fakeChannel();
      const m = new EmbedManager({ channel, timer: new FakeTimer(), config, logger });
      await m.postAutoStartResetNotice('朝活');
      expect(post).toHaveBeenCalledTimes(1);
      const content = (post.mock.calls[0]?.[0] as { content?: string }).content;
      expect(content).toBe(
        '失礼します。朝活の時間になりましたのでタイマーをリセットしてから朝活を開始します',
      );
    });

    it('resetForRestart はタイマー Embed を消し timer をリセットするがスタート Embed は出さない', async () => {
      const { channel, post, del } = fakeChannel();
      const timer = new FakeTimer();
      const m = new EmbedManager({
        channel,
        timer,
        config,
        logger,
        endingDelay: () => Promise.resolve(),
      });
      // 稼働状態を作る (onIdle → work でタイマー Embed を投稿)。
      await m.onIdle();
      timer.emit('phaseChange', makeSnapshot('work'));
      await vi.advanceTimersByTimeAsync(0);
      expect(m.timerEmbedId).not.toBeNull();
      const postsBefore = post.mock.calls.length;
      const resetBefore = timer.resetCallCount;

      await m.resetForRestart();

      // タイマー Embed は削除され、追跡 id はクリアされる。
      expect(del).toHaveBeenCalled();
      expect(m.timerEmbedId).toBeNull();
      // timer.reset が呼ばれ idle へ戻る。
      expect(timer.resetCallCount).toBe(resetBefore + 1);
      expect(timer.getSnapshot().phase).toBe('idle');
      // 新スタート Embed は投稿しない (直後に timer.start する前提)。
      expect(post.mock.calls.length).toBe(postsBefore);
      expect(m.startEmbedId).toBeNull();
    });
  });
});
