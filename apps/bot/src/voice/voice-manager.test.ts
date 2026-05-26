import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { TimerSnapshot } from '@co-working-call/shared';
import {
  VoiceManager,
  classifyHumanCountTransition,
  isTargetVcEvent,
  isTimerRunning,
  type VoiceConnectionHandle,
} from './voice-manager.js';

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function snapshot(phase: TimerSnapshot['phase']): TimerSnapshot {
  return { phase, remainingMs: 0, currentSet: 0, totalSets: 0, startedAt: null };
}

function setup(opts?: {
  connectNull?: boolean;
  phase?: TimerSnapshot['phase'];
  /** US-20: 終了演出フローを注入するかどうか。 */
  withTriggerEndingFlow?: boolean;
  /** triggerEndingFlow が reject するか (best-effort 検証用)。 */
  triggerEndingFlowRejects?: boolean;
}) {
  const destroy = vi.fn();
  const subscribe = vi.fn();
  const connection: VoiceConnectionHandle = { subscribe, destroy };
  const connect = vi.fn<() => Promise<VoiceConnectionHandle | null>>(() =>
    Promise.resolve(opts?.connectNull ? null : connection),
  );
  const soundPlayer = { init: vi.fn(), stop: vi.fn() };
  const timer = { getSnapshot: vi.fn(() => snapshot(opts?.phase ?? 'idle')), stop: vi.fn() };
  const resetToIdle = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const triggerEndingFlow = vi.fn<() => Promise<void>>(() =>
    opts?.triggerEndingFlowRejects ? Promise.reject(new Error('ending failed')) : Promise.resolve(),
  );
  const vm = new VoiceManager({
    logger,
    soundPlayer,
    timer,
    connect,
    resetToIdle,
    triggerEndingFlow: opts?.withTriggerEndingFlow ? triggerEndingFlow : undefined,
  });
  return { vm, connect, connection, destroy, soundPlayer, timer, resetToIdle, triggerEndingFlow };
}

describe('classifyHumanCountTransition', () => {
  it('0→1+ は enter、1+→0 は leave、それ以外は none', () => {
    expect(classifyHumanCountTransition(0, 1)).toBe('enter');
    expect(classifyHumanCountTransition(0, 3)).toBe('enter');
    expect(classifyHumanCountTransition(1, 0)).toBe('leave');
    expect(classifyHumanCountTransition(2, 0)).toBe('leave');
    expect(classifyHumanCountTransition(1, 2)).toBe('none');
    expect(classifyHumanCountTransition(0, 0)).toBe('none');
    expect(classifyHumanCountTransition(2, 1)).toBe('none');
  });
});

describe('isTargetVcEvent', () => {
  it('旧 or 新チャンネルが対象 VC なら true', () => {
    expect(isTargetVcEvent({ oldChannelId: null, newChannelId: 'vc', targetVcId: 'vc' })).toBe(
      true,
    );
    expect(isTargetVcEvent({ oldChannelId: 'vc', newChannelId: null, targetVcId: 'vc' })).toBe(
      true,
    );
    expect(isTargetVcEvent({ oldChannelId: 'x', newChannelId: 'y', targetVcId: 'vc' })).toBe(false);
    expect(isTargetVcEvent({ oldChannelId: null, newChannelId: null, targetVcId: 'vc' })).toBe(
      false,
    );
  });
});

describe('isTimerRunning', () => {
  it('work/break/finalBreak/countdown は実行中、idle/ended は非実行', () => {
    expect(isTimerRunning('work')).toBe(true);
    expect(isTimerRunning('break')).toBe(true);
    expect(isTimerRunning('finalBreak')).toBe(true);
    expect(isTimerRunning('countdown')).toBe(true);
    expect(isTimerRunning('idle')).toBe(false);
    expect(isTimerRunning('ended')).toBe(false);
  });
});

describe('VoiceManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('0→1+ で接続し SoundPlayer を init する', async () => {
    const { vm, connect, connection, soundPlayer } = setup();
    await vm.handleHumanCountChange(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(soundPlayer.init).toHaveBeenCalledWith(connection);
    expect(vm.connected).toBe(true);
  });

  it('接続失敗 (null) なら init せず connected は false のまま', async () => {
    const { vm, soundPlayer } = setup({ connectNull: true });
    await vm.handleHumanCountChange(1);
    expect(soundPlayer.init).not.toHaveBeenCalled();
    expect(vm.connected).toBe(false);
  });

  it('1+→1+ や 0→0 では接続処理をしない', async () => {
    const { vm, connect } = setup();
    await vm.handleHumanCountChange(2); // 0→2 = enter
    expect(connect).toHaveBeenCalledTimes(1);
    await vm.handleHumanCountChange(3); // 2→3 = none
    await vm.handleHumanCountChange(1); // 3→1 = none
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('1+→0 の 1 分後に退出 (idle なら timer.stop しない)', async () => {
    const { vm, connect, destroy, soundPlayer, timer, resetToIdle } = setup({ phase: 'idle' });
    await vm.handleHumanCountChange(1); // 接続
    expect(connect).toHaveBeenCalledTimes(1);

    await vm.handleHumanCountChange(0); // 退出カウントダウン開始
    expect(destroy).not.toHaveBeenCalled(); // まだ退出しない

    await vi.advanceTimersByTimeAsync(60_000);
    expect(timer.stop).not.toHaveBeenCalled(); // idle なので停止不要
    expect(soundPlayer.stop).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(resetToIdle).toHaveBeenCalledTimes(1);
    expect(vm.connected).toBe(false);
  });

  it('退出時タイマー実行中で triggerEndingFlow 未注入なら暗定復帰 (timer.stop + disconnect + resetToIdle)', async () => {
    const { vm, timer, destroy, resetToIdle } = setup({ phase: 'work' });
    await vm.handleHumanCountChange(1);
    await vm.handleHumanCountChange(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(timer.stop).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(resetToIdle).toHaveBeenCalledTimes(1);
  });

  it('1 分以内の再入室で退出カウントダウンをキャンセルし接続を維持する', async () => {
    const { vm, connect, destroy, soundPlayer } = setup();
    await vm.handleHumanCountChange(1); // 接続 (init 1回)
    await vm.handleHumanCountChange(0); // CD 開始
    await vm.handleHumanCountChange(1); // 30秒以内想定の再入室

    await vi.advanceTimersByTimeAsync(60_000);
    expect(destroy).not.toHaveBeenCalled(); // 退出しない
    expect(connect).toHaveBeenCalledTimes(1); // 再接続しない
    expect(soundPlayer.init).toHaveBeenCalledTimes(1); // init も1回のまま
    expect(vm.connected).toBe(true);
  });

  it('US-20: タイマー実行中 + triggerEndingFlow 注入時は終了演出フローを発動し、暗定復帰経路は使わない', async () => {
    const { vm, timer, destroy, resetToIdle, triggerEndingFlow } = setup({
      phase: 'work',
      withTriggerEndingFlow: true,
    });
    await vm.handleHumanCountChange(1);
    await vm.handleHumanCountChange(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(triggerEndingFlow).toHaveBeenCalledTimes(1);
    // timer.stop / destroy / resetToIdle は triggerEndingFlow 内部 (本番は EmbedManager.onEnded
    // 経由) で行われる想定。VoiceManager 自身では発動しない。
    expect(timer.stop).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(resetToIdle).not.toHaveBeenCalled();
  });

  it('US-20: idle 中は triggerEndingFlow を呼ばず暗定復帰のまま (タイマー停止も不要)', async () => {
    const { vm, timer, destroy, resetToIdle, triggerEndingFlow } = setup({
      phase: 'idle',
      withTriggerEndingFlow: true,
    });
    await vm.handleHumanCountChange(1);
    await vm.handleHumanCountChange(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(triggerEndingFlow).not.toHaveBeenCalled();
    expect(timer.stop).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(resetToIdle).toHaveBeenCalledTimes(1);
  });

  it('US-20: triggerEndingFlow が reject しても例外を伝播させない (best-effort)', async () => {
    const { vm, triggerEndingFlow } = setup({
      phase: 'work',
      withTriggerEndingFlow: true,
      triggerEndingFlowRejects: true,
    });
    await vm.handleHumanCountChange(1);
    await vm.handleHumanCountChange(0);
    // 例外が伝播するなら ここで unhandled rejection でテストが落ちる。
    // 到達すれば伝播していない＝best-effort で握りつぶされている。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(triggerEndingFlow).toHaveBeenCalledTimes(1);
  });

  it('forceDisconnect は即時退出しカウントダウンを止める', async () => {
    const { vm, destroy, soundPlayer } = setup();
    await vm.handleHumanCountChange(1);
    await vm.handleHumanCountChange(0); // CD 開始
    vm.forceDisconnect();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(soundPlayer.stop).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(destroy).toHaveBeenCalledTimes(1); // CD は発火しない
  });

  it('US-21: #onLeave で退出カウントダウン開始の info ログを出す', async () => {
    const { vm } = setup();
    await vm.handleHumanCountChange(1);
    const infoMock = logger.info as unknown as ReturnType<typeof vi.fn>;
    infoMock.mockClear();
    await vm.handleHumanCountChange(0);
    // pino API は (obj, msg) と (msg) の両形があり、メッセージ本体は最後の文字列引数。
    // 全 call の文字列引数を走査し、目的のメッセージが含まれる呼び出しがあるか確認する。
    const found = infoMock.mock.calls.some((call) =>
      (call as unknown[]).some(
        (arg) => typeof arg === 'string' && arg.includes('退出カウントダウンを開始'),
      ),
    );
    expect(found).toBe(true);
  });

  it('US-21: connect 例外時は error でなく warn ログ (リトライしないが致命的でない)', async () => {
    const connect = vi.fn<() => Promise<VoiceConnectionHandle | null>>(() =>
      Promise.reject(new Error('boom')),
    );
    const soundPlayer = { init: vi.fn(), stop: vi.fn() };
    const timer = { getSnapshot: vi.fn(() => snapshot('idle')), stop: vi.fn() };
    const resetToIdle = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const warnMock = logger.warn as unknown as ReturnType<typeof vi.fn>;
    const errorMock = logger.error as unknown as ReturnType<typeof vi.fn>;
    warnMock.mockClear();
    errorMock.mockClear();
    const vm = new VoiceManager({ logger, soundPlayer, timer, connect, resetToIdle });
    await vm.handleHumanCountChange(1);
    expect(warnMock).toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
  });

  it('ensureConnected: 未接続なら接続+init し true', async () => {
    const { vm, connect, connection, soundPlayer } = setup();
    const ok = await vm.ensureConnected();
    expect(ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(soundPlayer.init).toHaveBeenCalledWith(connection);
    expect(vm.connected).toBe(true);
  });

  it('ensureConnected: 接続済みなら再接続せず true', async () => {
    const { vm, connect } = setup();
    await vm.handleHumanCountChange(1); // 自動入室で接続済みに
    expect(connect).toHaveBeenCalledTimes(1);
    const ok = await vm.ensureConnected();
    expect(ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1); // 再接続しない
  });

  it('ensureConnected: 接続失敗なら false', async () => {
    const { vm } = setup({ connectNull: true });
    const ok = await vm.ensureConnected();
    expect(ok).toBe(false);
    expect(vm.connected).toBe(false);
  });
});
