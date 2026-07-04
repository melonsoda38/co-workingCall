import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContinueSessionState } from './continue-session-state.js';

const CAP_MS = 23 * 60 * 60 * 1000;

describe('ContinueSessionState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('register は continuing を立て残留ユーザ数を返す (重複は加算しない)', () => {
    const state = new ContinueSessionState({ capMs: CAP_MS, onCap: vi.fn() });
    expect(state.shouldContinue()).toBe(false);
    expect(state.register('u1')).toBe(1);
    expect(state.register('u2')).toBe(2);
    expect(state.register('u1')).toBe(2); // 重複
    expect(state.shouldContinue()).toBe(true);
    expect([...state.userIds]).toEqual(['u1', 'u2']);
  });

  it('markContinuousActive 後は shouldContinue が false (移行済み)', () => {
    const state = new ContinueSessionState({ capMs: CAP_MS, onCap: vi.fn() });
    state.register('u1');
    state.markContinuousActive();
    expect(state.continuousActive).toBe(true);
    expect(state.shouldContinue()).toBe(false);
  });

  it('begin は継続用の作業/休憩秒・baseSets を確保し 23時間キャップを arm する', () => {
    const onCap = vi.fn();
    const state = new ContinueSessionState({ capMs: CAP_MS, onCap });
    state.begin({ workSec: 1500, breakSec: 300, baseSets: 4 });
    expect(state.workSec).toBe(1500);
    expect(state.breakSec).toBe(300);
    expect(state.baseSets).toBe(4);
    expect(onCap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CAP_MS);
    expect(onCap).toHaveBeenCalledTimes(1);
  });

  it('reset は続行状態をクリアしキャップも解除する (onCap 発火しない)', () => {
    const onCap = vi.fn();
    const state = new ContinueSessionState({ capMs: CAP_MS, onCap });
    state.register('u1');
    state.begin({ workSec: 1, breakSec: 1, baseSets: 1 });
    state.reset();
    expect(state.shouldContinue()).toBe(false);
    expect(state.continuousActive).toBe(false);
    expect([...state.userIds]).toEqual([]);
    vi.advanceTimersByTime(CAP_MS);
    expect(onCap).not.toHaveBeenCalled();
  });

  it('begin を張り替えると古いキャップは無効化され最新のみ発火する', () => {
    const onCap = vi.fn();
    const state = new ContinueSessionState({ capMs: CAP_MS, onCap });
    state.begin({ workSec: 1, breakSec: 1, baseSets: 1 });
    vi.advanceTimersByTime(CAP_MS / 2);
    state.begin({ workSec: 2, breakSec: 2, baseSets: 2 }); // 張り替え
    vi.advanceTimersByTime(CAP_MS / 2); // 旧キャップ満了タイミングだが張替済みで発火しない
    expect(onCap).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CAP_MS / 2); // 新キャップ満了
    expect(onCap).toHaveBeenCalledTimes(1);
  });
});
