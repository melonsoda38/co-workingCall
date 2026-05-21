import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { TimerSnapshot } from '@co-working-call/shared';
import {
  VoiceManager,
  classifyHumanCountTransition,
  isTargetVcEvent,
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

function setup(opts?: { connectNull?: boolean; phase?: TimerSnapshot['phase'] }) {
  const destroy = vi.fn();
  const subscribe = vi.fn();
  const connection: VoiceConnectionHandle = { subscribe, destroy };
  const connect = vi.fn<() => Promise<VoiceConnectionHandle | null>>(() =>
    Promise.resolve(opts?.connectNull ? null : connection),
  );
  const soundPlayer = { init: vi.fn(), stop: vi.fn() };
  const timer = { getSnapshot: vi.fn(() => snapshot(opts?.phase ?? 'idle')), stop: vi.fn() };
  const sendEntryMessage = vi.fn();
  const resetToIdle = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const vm = new VoiceManager({
    logger,
    soundPlayer,
    timer,
    connect,
    sendEntryMessage,
    resetToIdle,
  });
  return { vm, connect, connection, destroy, soundPlayer, timer, sendEntryMessage, resetToIdle };
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

describe('VoiceManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('0→1+ で接続し SoundPlayer を init・入室メッセージを送る', async () => {
    const { vm, connect, connection, soundPlayer, sendEntryMessage } = setup();
    await vm.handleHumanCountChange(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(soundPlayer.init).toHaveBeenCalledWith(connection);
    expect(sendEntryMessage).toHaveBeenCalledTimes(1);
    expect(vm.connected).toBe(true);
  });

  it('接続失敗 (null) なら init せず connected は false のまま', async () => {
    const { vm, soundPlayer, sendEntryMessage } = setup({ connectNull: true });
    await vm.handleHumanCountChange(1);
    expect(soundPlayer.init).not.toHaveBeenCalled();
    expect(sendEntryMessage).not.toHaveBeenCalled();
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

  it('退出時タイマー実行中なら timer.stop して暗定復帰する', async () => {
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
});
