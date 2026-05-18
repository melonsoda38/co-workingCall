import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepostDebouncer } from './repost-debouncer.js';

describe('RepostDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('trigger 後 debounce 経過で callback 実行', async () => {
    const cb = vi.fn();
    const d = new RepostDebouncer({ callback: cb, debounceMs: 1000, maxWaitMs: 5000 });
    d.trigger();
    expect(cb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('連続 trigger で debounce がリセットされる', async () => {
    const cb = vi.fn();
    const d = new RepostDebouncer({ callback: cb, debounceMs: 1000, maxWaitMs: 10_000 });
    d.trigger();
    await vi.advanceTimersByTimeAsync(800);
    d.trigger();
    await vi.advanceTimersByTimeAsync(800);
    expect(cb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('maxWait 経過で debounce リセット中でも強制実行', async () => {
    const cb = vi.fn();
    const d = new RepostDebouncer({ callback: cb, debounceMs: 1000, maxWaitMs: 3000 });
    d.trigger();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(900);
      d.trigger();
    }
    // 累計 ~3600ms。debounce(1000) は毎回リセットされるが maxWait(3000) で1回発火。
    expect(cb).toHaveBeenCalledTimes(1);
    d.cancel();
  });

  it('cancel でタイマーをクリアし発火しない', async () => {
    const cb = vi.fn();
    const d = new RepostDebouncer({ callback: cb, debounceMs: 1000, maxWaitMs: 5000 });
    d.trigger();
    d.cancel();
    await vi.advanceTimersByTimeAsync(6000);
    expect(cb).not.toHaveBeenCalled();
    expect(d.firstTriggerAt).toBeNull();
  });

  it('callback 失敗時は onError 通知し isReposting を解除', async () => {
    const err = new Error('boom');
    const onError = vi.fn();
    const cb = vi.fn(() => Promise.reject(err));
    const d = new RepostDebouncer({
      callback: cb,
      debounceMs: 1000,
      maxWaitMs: 5000,
      onError,
    });
    d.trigger();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledWith(err);
    expect(d.isReposting).toBe(false);
  });

  it('実行中の trigger は完了後に新サイクルで集約処理', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cb = vi.fn(() => gate);
    const d = new RepostDebouncer({ callback: cb, debounceMs: 1000, maxWaitMs: 9000 });

    d.trigger();
    await vi.advanceTimersByTimeAsync(1000);
    expect(d.isReposting).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);

    // 実行中に複数 trigger (集約され1回の次サイクルになる)
    d.trigger();
    d.trigger();

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(d.isReposting).toBe(false);

    // 次サイクルの debounce 経過で2回目
    await vi.advanceTimersByTimeAsync(1000);
    expect(cb).toHaveBeenCalledTimes(2);
    d.cancel();
  });
});
