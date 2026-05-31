import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { acquireSingleInstance, isProcessAlive } from './single-instance.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

describe('acquireSingleInstance', () => {
  let dir: string;
  let pidFilePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'pomo-pid-'));
    pidFilePath = join(dir, 'bot.pid');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('初回呼び出しは pidfile を作成して acquired:true を返す', () => {
    const result = acquireSingleInstance({
      pidFilePath,
      logger,
      currentPid: 12345,
      isAlive: () => false,
    });
    expect(result.acquired).toBe(true);
    expect(readFileSync(pidFilePath, 'utf8')).toBe('12345');
  });

  it('既存 pidfile の PID が生きていれば acquired:false で fatal ログを残す', () => {
    writeFileSync(pidFilePath, '99999', 'utf8');
    const result = acquireSingleInstance({
      pidFilePath,
      logger,
      currentPid: 12345,
      isAlive: (pid) => pid === 99999,
    });
    expect(result.acquired).toBe(false);
    expect(logger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ existingPid: 99999 }),
      expect.stringContaining('既に起動中'),
    );
    // 既存プロセスの pidfile を上書きしないこと
    expect(readFileSync(pidFilePath, 'utf8')).toBe('99999');
  });

  it('既存 pidfile の PID が死んでいれば stale 扱いで上書きする', () => {
    writeFileSync(pidFilePath, '99999', 'utf8');
    const result = acquireSingleInstance({
      pidFilePath,
      logger,
      currentPid: 12345,
      isAlive: () => false,
    });
    expect(result.acquired).toBe(true);
    expect(readFileSync(pidFilePath, 'utf8')).toBe('12345');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ stalePid: '99999' }),
      expect.stringContaining('stale'),
    );
  });

  it('壊れた中身の pidfile も stale 扱いで上書きする', () => {
    writeFileSync(pidFilePath, 'corrupted-not-a-number', 'utf8');
    const result = acquireSingleInstance({
      pidFilePath,
      logger,
      currentPid: 12345,
      isAlive: () => false,
    });
    expect(result.acquired).toBe(true);
    expect(readFileSync(pidFilePath, 'utf8')).toBe('12345');
  });

  it('release を呼ぶと pidfile が削除される', () => {
    const result = acquireSingleInstance({
      pidFilePath,
      logger,
      currentPid: 12345,
      isAlive: () => false,
    });
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      result.release();
      expect(() => readFileSync(pidFilePath, 'utf8')).toThrow();
    }
  });

  it('release を二重呼び出ししても例外を投げない (best-effort)', () => {
    const result = acquireSingleInstance({
      pidFilePath,
      logger,
      currentPid: 12345,
      isAlive: () => false,
    });
    expect(result.acquired).toBe(true);
    if (result.acquired) {
      result.release();
      expect(() => {
        result.release();
      }).not.toThrow();
    }
  });
});

describe('isProcessAlive', () => {
  it('現在のプロセスは生きている', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('十分大きな存在しない PID は死んでいる扱い', () => {
    // 2_000_000_000 は通常システム上に存在しない PID。
    expect(isProcessAlive(2_000_000_000)).toBe(false);
  });
});
