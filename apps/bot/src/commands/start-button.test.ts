import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import type { VoiceSession } from '../voice/session-registry.js';
import { handleStartButton, isExecutorInTargetVc } from './start-button.js';

vi.mock('../config/index.js', () => ({ loadConfig: vi.fn() }));
import { loadConfig } from '../config/index.js';

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const TARGET_VC = 'vc-1';

const DEFAULT_TIMER: BotConfig['default'] = {
  workSec: 1500,
  breakSec: 300,
  sets: 4,
  finalBreakSec: 900,
};

function snapshot(phase: TimerSnapshot['phase']): TimerSnapshot {
  return { phase, remainingMs: 0, currentSet: 0, totalSets: 0, startedAt: null };
}

function makeInteraction(opts: { memberVcId: string | null; messageId?: string }) {
  const reply = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const deferUpdate = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const fetch = vi.fn(() => Promise.resolve({ voice: { channelId: opts.memberVcId } }));
  const interaction = {
    user: { id: 'user-1' },
    guildId: 'guild-1',
    guild: { id: 'guild-1', members: { fetch } },
    message: { id: opts.messageId ?? 'start-embed-msg' },
    replied: false,
    deferred: false,
    reply,
    deferUpdate,
  } as unknown as ButtonInteraction;
  return { interaction, reply, deferUpdate, fetch };
}

function makeSession(opts?: { phase?: TimerSnapshot['phase']; connected?: boolean }): {
  session: VoiceSession;
  start: ReturnType<typeof vi.fn>;
  ensureConnected: ReturnType<typeof vi.fn>;
  applyConfig: ReturnType<typeof vi.fn>;
  adoptStartEmbed: ReturnType<typeof vi.fn>;
} {
  const start = vi.fn();
  const getSnapshot = vi.fn(() => snapshot(opts?.phase ?? 'idle'));
  const ensureConnected = vi.fn(() => Promise.resolve(opts?.connected ?? true));
  const applyConfig = vi.fn();
  const adoptStartEmbed = vi.fn();
  const config: BotConfig = {
    default: DEFAULT_TIMER,
    guildId: 'guild-1',
    voiceChannelId: TARGET_VC,
    adminRoleName: 'pomo-admin',
    adminRoleNames: [],
  };
  const session = {
    config,
    timer: { getSnapshot, start },
    embedManager: { applyConfig, adoptStartEmbed },
    voiceManager: { ensureConnected },
  } as unknown as VoiceSession;
  return { session, start, ensureConnected, applyConfig, adoptStartEmbed };
}

describe('isExecutorInTargetVc', () => {
  it('対象 VC と一致すれば true、それ以外 (別 VC / null) は false', () => {
    expect(isExecutorInTargetVc(TARGET_VC, TARGET_VC)).toBe(true);
    expect(isExecutorInTargetVc('other', TARGET_VC)).toBe(false);
    expect(isExecutorInTargetVc(null, TARGET_VC)).toBe(false);
    expect(isExecutorInTargetVc(undefined, TARGET_VC)).toBe(false);
  });
});

describe('handleStartButton', () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockResolvedValue({
      status: 'ok',
      config: {
        default: DEFAULT_TIMER,
        guildId: 'guild-1',
        voiceChannelId: TARGET_VC,
        adminRoleName: 'pomo-admin',
        adminRoleNames: [],
      },
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('session が無ければ ephemeral 応答しタイマーを開始しない', async () => {
    const { interaction, reply } = makeInteraction({ memberVcId: TARGET_VC });
    await handleStartButton(interaction, undefined, 'cfg.json', logger);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('実行者が対象 VC にいなければ ephemeral 応答し開始しない', async () => {
    const { interaction, reply, deferUpdate } = makeInteraction({ memberVcId: 'other-vc' });
    const { session, start } = makeSession();
    await handleStartButton(interaction, session, 'cfg.json', logger);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(deferUpdate).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('すでにタイマー動作中なら ephemeral 応答し再開始しない', async () => {
    const { interaction, reply } = makeInteraction({ memberVcId: TARGET_VC });
    const { session, start } = makeSession({ phase: 'work' });
    await handleStartButton(interaction, session, 'cfg.json', logger);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('VC 接続に失敗したら ephemeral 応答し開始しない', async () => {
    const { interaction, reply, deferUpdate } = makeInteraction({ memberVcId: TARGET_VC });
    const { session, start } = makeSession({ connected: false });
    await handleStartButton(interaction, session, 'cfg.json', logger);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(deferUpdate).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it('正常系: スタート Embed を採用・ack し config.json の最新値で timer.start する', async () => {
    const { interaction, deferUpdate, reply } = makeInteraction({
      memberVcId: TARGET_VC,
      messageId: 'clicked-start-embed',
    });
    const { session, start, applyConfig, adoptStartEmbed, ensureConnected } = makeSession();
    await handleStartButton(interaction, session, 'cfg.json', logger);

    expect(reply).not.toHaveBeenCalled();
    expect(ensureConnected).toHaveBeenCalledTimes(1);
    expect(applyConfig).toHaveBeenCalledTimes(1);
    expect(adoptStartEmbed).toHaveBeenCalledWith('clicked-start-embed');
    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(DEFAULT_TIMER);
  });
});
