import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { guildConfigPath, saveVcConfig } from '../config/index.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { BotConfig, TimerPhase } from '@co-working-call/shared';
import type { VoiceSession } from '../voice/session-registry.js';
import { runAutoStart } from './run-auto-start.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const baseConfig: BotConfig = {
  default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 },
  guildId: '1001',
  voiceChannelId: 'vc',
  adminRoleName: 'pomo-admin',
  adminRoleNames: [],
  volumes: { workEnd: 0, breakEnd: 0, finalStart: 0, countdownWarning: 0, finish: 0 },
  autoStart: { time: '07:30', label: '朝活' },
};

interface Mocks {
  start: ReturnType<typeof vi.fn>;
  postAutoStartResetNotice: ReturnType<typeof vi.fn>;
  resetForRestart: ReturnType<typeof vi.fn>;
  ensureConnected: ReturnType<typeof vi.fn>;
  applyConfig: ReturnType<typeof vi.fn>;
  setVolumes: ReturnType<typeof vi.fn>;
}

function makeSession(opts: {
  phase: TimerPhase;
  isEnding?: boolean;
  ensureConnectedResult?: boolean;
}): { session: VoiceSession; mocks: Mocks } {
  const mocks: Mocks = {
    start: vi.fn(),
    postAutoStartResetNotice: vi.fn(() => Promise.resolve()),
    resetForRestart: vi.fn(() => Promise.resolve()),
    ensureConnected: vi.fn(() => Promise.resolve(opts.ensureConnectedResult ?? true)),
    applyConfig: vi.fn(),
    setVolumes: vi.fn(),
  };
  const session = {
    config: baseConfig,
    timer: {
      getSnapshot: () => ({ phase: opts.phase }),
      start: mocks.start,
    },
    embedManager: {
      isEnding: opts.isEnding ?? false,
      postAutoStartResetNotice: mocks.postAutoStartResetNotice,
      resetForRestart: mocks.resetForRestart,
      applyConfig: mocks.applyConfig,
    },
    voiceManager: { ensureConnected: mocks.ensureConnected },
    soundPlayer: { setVolumes: mocks.setVolumes },
  } as unknown as VoiceSession;
  return { session, mocks };
}

describe('runAutoStart', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cowork-autostart-'));
    await saveVcConfig(dir, baseConfig);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('idle 時: お知らせ無しで入室しタイマーを開始する', async () => {
    const { session, mocks } = makeSession({ phase: 'idle' });

    await runAutoStart(session, dir, logger);

    expect(mocks.postAutoStartResetNotice).not.toHaveBeenCalled();
    expect(mocks.resetForRestart).not.toHaveBeenCalled();
    expect(mocks.ensureConnected).toHaveBeenCalledTimes(1);
    expect(mocks.applyConfig).toHaveBeenCalledWith(baseConfig);
    expect(mocks.setVolumes).toHaveBeenCalledWith(baseConfig.volumes);
    expect(mocks.start).toHaveBeenCalledWith(baseConfig.default);
  });

  it('稼働中 (work) 時: お知らせ投稿 → リセット → 開始の順で実行する', async () => {
    const { session, mocks } = makeSession({ phase: 'work' });

    await runAutoStart(session, dir, logger);

    expect(mocks.postAutoStartResetNotice).toHaveBeenCalledWith('朝活');
    expect(mocks.resetForRestart).toHaveBeenCalledTimes(1);
    // お知らせ → リセットの順 (リセット前に投稿する仕様)。
    expect(mocks.postAutoStartResetNotice.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resetForRestart.mock.invocationCallOrder[0] ?? Infinity,
    );
    expect(mocks.start).toHaveBeenCalledWith(baseConfig.default);
  });

  it('終了演出中 (isEnding) もリセット経路に入る', async () => {
    const { session, mocks } = makeSession({ phase: 'idle', isEnding: true });

    await runAutoStart(session, dir, logger);

    expect(mocks.postAutoStartResetNotice).toHaveBeenCalledWith('朝活');
    expect(mocks.resetForRestart).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledWith(baseConfig.default);
  });

  it('VC 接続に失敗したらタイマーを開始しない', async () => {
    const { session, mocks } = makeSession({ phase: 'idle', ensureConnectedResult: false });

    await runAutoStart(session, dir, logger);

    expect(mocks.ensureConnected).toHaveBeenCalledTimes(1);
    expect(mocks.applyConfig).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('config が無効ならログのみで何もしない', async () => {
    await writeFile(guildConfigPath(dir, '1001'), '{ broken json', 'utf-8');
    const { session, mocks } = makeSession({ phase: 'idle' });

    await runAutoStart(session, dir, logger);

    expect(mocks.ensureConnected).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
