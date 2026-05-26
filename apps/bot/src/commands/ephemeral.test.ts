import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { EPHEMERAL_AUTO_DELETE_MS, scheduleEphemeralAutoDelete } from './ephemeral.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

describe('scheduleEphemeralAutoDelete', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('既定 14 分後に deleteReply を呼ぶ', async () => {
    const deleteReply = vi.fn(() => Promise.resolve());
    scheduleEphemeralAutoDelete({ deleteReply, deferred: true, replied: false }, logger);

    expect(deleteReply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EPHEMERAL_AUTO_DELETE_MS - 1);
    expect(deleteReply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deleteReply).toHaveBeenCalledTimes(1);
  });

  it('replied=true でもスケジュールされる', async () => {
    const deleteReply = vi.fn(() => Promise.resolve());
    scheduleEphemeralAutoDelete({ deleteReply, deferred: false, replied: true }, logger);
    await vi.advanceTimersByTimeAsync(EPHEMERAL_AUTO_DELETE_MS);
    expect(deleteReply).toHaveBeenCalledTimes(1);
  });

  it('未応答 (deferred/replied 双方 false) ならスケジュールしない', async () => {
    const deleteReply = vi.fn();
    scheduleEphemeralAutoDelete({ deleteReply, deferred: false, replied: false }, logger);
    await vi.advanceTimersByTimeAsync(EPHEMERAL_AUTO_DELETE_MS * 2);
    expect(deleteReply).not.toHaveBeenCalled();
  });

  it('delayMs を指定すればその時間で発火する (テスト差し替え用)', async () => {
    const deleteReply = vi.fn(() => Promise.resolve());
    scheduleEphemeralAutoDelete({ deleteReply, deferred: true, replied: false }, logger, 100);
    await vi.advanceTimersByTimeAsync(99);
    expect(deleteReply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deleteReply).toHaveBeenCalledTimes(1);
  });

  it('deleteReply が reject しても例外を伝播させない (best-effort)', async () => {
    const deleteReply = vi.fn(() => Promise.reject(new Error('already deleted')));
    scheduleEphemeralAutoDelete({ deleteReply, deferred: true, replied: false }, logger, 50);
    await vi.advanceTimersByTimeAsync(50);
    // reject が起きても本テスト関数を抜けられる = 伝播していない
    expect(deleteReply).toHaveBeenCalledTimes(1);
  });
});
