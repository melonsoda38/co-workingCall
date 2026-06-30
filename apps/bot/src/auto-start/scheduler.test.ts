import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { AutoStartScheduler, nextJstOccurrenceEpochMs } from './scheduler.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** JST の y/m/d/h/m を epoch ms に変換するヘルパ (テスト期待値の組み立て用)。 */
function jstEpoch(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h, mi, 0, 0) - JST_OFFSET_MS;
}

describe('nextJstOccurrenceEpochMs', () => {
  it('当日 JST の時刻がまだ未来ならその当日を返す', () => {
    // 2026-06-29 06:00 JST 時点で 07:30 を求める → 当日 07:30 JST。
    const now = jstEpoch(2026, 6, 29, 6, 0);
    expect(nextJstOccurrenceEpochMs('07:30', now)).toBe(jstEpoch(2026, 6, 29, 7, 30));
  });

  it('当日 JST の時刻が既に過ぎていれば翌日を返す', () => {
    // 2026-06-29 08:00 JST 時点で 07:30 を求める → 翌日 06-30 07:30 JST。
    const now = jstEpoch(2026, 6, 29, 8, 0);
    expect(nextJstOccurrenceEpochMs('07:30', now)).toBe(jstEpoch(2026, 6, 30, 7, 30));
  });

  it('時刻ちょうど (<=) は翌日扱いにする', () => {
    const now = jstEpoch(2026, 6, 29, 7, 30);
    expect(nextJstOccurrenceEpochMs('07:30', now)).toBe(jstEpoch(2026, 6, 30, 7, 30));
  });

  it('UTC では前日でも JST 当日として正しく解釈する (JST 境界)', () => {
    // 2026-06-29 00:10 JST = 2026-06-28 15:10 UTC。00:30 JST はまだ未来 → 当日 00:30 JST。
    const now = jstEpoch(2026, 6, 29, 0, 10);
    const next = nextJstOccurrenceEpochMs('00:30', now);
    expect(next).toBe(jstEpoch(2026, 6, 29, 0, 30));
    // 発火まで 20 分。
    expect(next - now).toBe(20 * 60 * 1000);
  });

  it('不正な時刻形式は例外を投げる', () => {
    expect(() => nextJstOccurrenceEpochMs('7:30', 0)).toThrow();
    expect(() => nextJstOccurrenceEpochMs('24:00', 0)).toThrow();
  });
});

describe('AutoStartScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('指定時刻に onFire を呼び、翌日へ自動で再武装する', async () => {
    const onFire = vi.fn<() => Promise<void>>(() => Promise.resolve());
    // 現在を 2026-06-29 06:00 JST に固定する。
    const now = jstEpoch(2026, 6, 29, 6, 0);
    vi.setSystemTime(now);
    const scheduler = new AutoStartScheduler({ logger, onFire });

    scheduler.schedule('07:30');
    expect(onFire).not.toHaveBeenCalled();
    expect(scheduler.scheduledTime).toBe('07:30');

    // 07:30 JST まで進めると発火する (90 分)。
    await vi.advanceTimersByTimeAsync(90 * 60 * 1000);
    expect(onFire).toHaveBeenCalledTimes(1);

    // 翌日 07:30 まで進めると再度発火する (24h 後)。
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(onFire).toHaveBeenCalledTimes(2);
  });

  it('time=null で無効化され onFire は呼ばれない', async () => {
    const onFire = vi.fn<() => Promise<void>>(() => Promise.resolve());
    vi.setSystemTime(jstEpoch(2026, 6, 29, 6, 0));
    const scheduler = new AutoStartScheduler({ logger, onFire });

    scheduler.schedule(null);
    expect(scheduler.scheduledTime).toBeNull();
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    expect(onFire).not.toHaveBeenCalled();
  });

  it('schedule 呼び直しで旧予約をクリアし、新時刻だけが発火する', async () => {
    const onFire = vi.fn<() => Promise<void>>(() => Promise.resolve());
    vi.setSystemTime(jstEpoch(2026, 6, 29, 6, 0));
    const scheduler = new AutoStartScheduler({ logger, onFire });

    scheduler.schedule('07:00'); // 60 分後
    scheduler.schedule('08:00'); // 旧予約をクリアし 120 分後へ

    // 旧 07:00 のタイミングでは発火しない。
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(onFire).not.toHaveBeenCalled();
    // 08:00 で発火。
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('stop で予約を解除する', async () => {
    const onFire = vi.fn<() => Promise<void>>(() => Promise.resolve());
    vi.setSystemTime(jstEpoch(2026, 6, 29, 6, 0));
    const scheduler = new AutoStartScheduler({ logger, onFire });

    scheduler.schedule('07:00');
    scheduler.stop();
    expect(scheduler.scheduledTime).toBeNull();
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    expect(onFire).not.toHaveBeenCalled();
  });

  it('onFire が例外を投げても再武装は継続する', async () => {
    const onFire = vi.fn<() => Promise<void>>(() => Promise.reject(new Error('boom')));
    vi.setSystemTime(jstEpoch(2026, 6, 29, 6, 0));
    const scheduler = new AutoStartScheduler({ logger, onFire });

    scheduler.schedule('07:00');
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(onFire).toHaveBeenCalledTimes(1);
    // 例外後も翌日分が武装されており、24h 後に再発火する。
    await vi.advanceTimersByTimeAsync(DAY_MS);
    expect(onFire).toHaveBeenCalledTimes(2);
  });
});
