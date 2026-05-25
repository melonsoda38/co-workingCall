import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import type { VoiceSession } from '../voice/session-registry.js';
import { handlePomoStop } from './pomo.js';

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const CONFIG: BotConfig = {
  default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 },
  guildId: 'guild-1',
  voiceChannelId: 'vc-1',
  adminRoleName: 'pomo-admin',
};

function makeInteraction(roleNames: string[]) {
  const deferReply = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const editReply = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const deleteReply = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const fetch = vi.fn(() =>
    Promise.resolve({ roles: { cache: roleNames.map((name) => ({ name })) } }),
  );
  const interaction = {
    user: { id: 'user-1' },
    guildId: 'guild-1',
    guild: { id: 'guild-1', members: { fetch } },
    deferred: true,
    replied: false,
    deferReply,
    editReply,
    deleteReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, deferReply, editReply, deleteReply, fetch };
}

function makeSession(): {
  session: VoiceSession;
  stop: ReturnType<typeof vi.fn>;
  onIdle: ReturnType<typeof vi.fn>;
  forceDisconnect: ReturnType<typeof vi.fn>;
} {
  const stop = vi.fn();
  const onIdle = vi.fn(() => Promise.resolve());
  const forceDisconnect = vi.fn();
  const session = {
    config: CONFIG,
    timer: { stop, getSnapshot: vi.fn() },
    embedManager: { onIdle },
    voiceManager: { forceDisconnect },
  } as unknown as VoiceSession;
  return { session, stop, onIdle, forceDisconnect };
}

describe('handlePomoStop', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('session が無ければ停止せず ephemeral 応答する', async () => {
    const { interaction, editReply } = makeInteraction(['pomo-admin']);
    await handlePomoStop(interaction, undefined, logger);
    expect(editReply).toHaveBeenCalledTimes(1);
  });

  it('pomo-admin ロールが無ければ停止しない', async () => {
    const { interaction, editReply } = makeInteraction(['member']);
    const { session, stop, onIdle, forceDisconnect } = makeSession();
    await handlePomoStop(interaction, session, logger);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(forceDisconnect).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('正常系: timer.stop / VC退出 / onIdle を呼び、確認メッセージは出さない', async () => {
    const { interaction, editReply, deleteReply } = makeInteraction(['pomo-admin']);
    const { session, stop, onIdle, forceDisconnect } = makeSession();
    await handlePomoStop(interaction, session, logger);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(forceDisconnect).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(deleteReply).toHaveBeenCalledTimes(1);
    expect(editReply).not.toHaveBeenCalled();
  });
});
