import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, type ChatInputCommandInteraction } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import type { VoiceSession } from '../voice/session-registry.js';
import { handleAdminRole, handlePomoJoin, handlePomoStop } from './pomo.js';

vi.mock('../config/index.js', () => ({ loadConfig: vi.fn(), saveConfig: vi.fn() }));
import { loadConfig, saveConfig } from '../config/index.js';

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
  adminRoleNames: [],
};

function makeInteraction(
  roleNames: string[],
  channelType: ChannelType = ChannelType.GuildVoice,
  options?: { subcommand?: string; roleName?: string },
) {
  const deferReply = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const editReply = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const deleteReply = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const fetch = vi.fn(() =>
    Promise.resolve({ roles: { cache: roleNames.map((name) => ({ name })) } }),
  );
  const getSubcommand = vi.fn(() => options?.subcommand ?? 'list');
  const getRole = vi.fn(() => ({ name: options?.roleName ?? 'mod' }));
  const interaction = {
    user: { id: 'user-1' },
    guildId: 'guild-1',
    guild: { id: 'guild-1', members: { fetch } },
    channel: { type: channelType },
    options: { getSubcommand, getRole },
    deferred: true,
    replied: false,
    deferReply,
    editReply,
    deleteReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, deferReply, editReply, deleteReply, fetch, getSubcommand, getRole };
}

function makeSession(opts?: { connected?: boolean; alreadyConnected?: boolean }): {
  session: VoiceSession;
  stop: ReturnType<typeof vi.fn>;
  onIdle: ReturnType<typeof vi.fn>;
  forceDisconnect: ReturnType<typeof vi.fn>;
  ensureConnected: ReturnType<typeof vi.fn>;
} {
  const stop = vi.fn();
  const onIdle = vi.fn(() => Promise.resolve());
  const forceDisconnect = vi.fn();
  const ensureConnected = vi.fn(() => Promise.resolve(opts?.connected ?? true));
  const session = {
    config: CONFIG,
    timer: { stop, getSnapshot: vi.fn() },
    embedManager: { onIdle },
    voiceManager: { forceDisconnect, ensureConnected, connected: opts?.alreadyConnected ?? false },
  } as unknown as VoiceSession;
  return { session, stop, onIdle, forceDisconnect, ensureConnected };
}

describe('handlePomoStop', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('テキストチャンネルで実行したら VC テキスト欄エラーを出し停止しない', async () => {
    const { interaction, editReply } = makeInteraction(['pomo-admin'], ChannelType.GuildText);
    const { session, stop, forceDisconnect } = makeSession();
    await handlePomoStop(interaction, session, logger);
    expect(editReply).toHaveBeenCalledWith(
      'このコマンドはボイスチャンネル内のテキスト欄で実行してください',
    );
    expect(stop).not.toHaveBeenCalled();
    expect(forceDisconnect).not.toHaveBeenCalled();
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

describe('handlePomoJoin', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('テキストチャンネルで実行したら VC テキスト欄エラーを出し再入室しない', async () => {
    const { interaction, editReply } = makeInteraction(['pomo-admin'], ChannelType.GuildText);
    const { session, ensureConnected } = makeSession();
    await handlePomoJoin(interaction, session, logger);
    expect(editReply).toHaveBeenCalledWith(
      'このコマンドはボイスチャンネル内のテキスト欄で実行してください',
    );
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it('session が無ければ再入室せず ephemeral 応答する', async () => {
    const { interaction, editReply } = makeInteraction(['pomo-admin']);
    await handlePomoJoin(interaction, undefined, logger);
    expect(editReply).toHaveBeenCalledTimes(1);
  });

  it('pomo-admin ロールが無ければ再入室しない', async () => {
    const { interaction, editReply } = makeInteraction(['member']);
    const { session, ensureConnected } = makeSession();
    await handlePomoJoin(interaction, session, logger);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(ensureConnected).not.toHaveBeenCalled();
  });

  it('正常系: ensureConnected で再入室し、確認メッセージは出さない', async () => {
    const { interaction, editReply, deleteReply } = makeInteraction(['pomo-admin']);
    const { session, ensureConnected, stop } = makeSession();
    await handlePomoJoin(interaction, session, logger);
    expect(ensureConnected).toHaveBeenCalledTimes(1);
    expect(deleteReply).toHaveBeenCalledTimes(1);
    expect(editReply).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled(); // タイマーは触らない
  });

  it('既に入室済みなら ensureConnected を呼ばず ephemeral エラーを出す', async () => {
    const { interaction, editReply, deleteReply } = makeInteraction(['pomo-admin']);
    const { session, ensureConnected } = makeSession({ alreadyConnected: true });
    await handlePomoJoin(interaction, session, logger);
    expect(ensureConnected).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(deleteReply).not.toHaveBeenCalled();
  });

  it('接続失敗なら ephemeral でエラー応答する', async () => {
    const { interaction, editReply, deleteReply } = makeInteraction(['pomo-admin']);
    const { session, ensureConnected } = makeSession({ connected: false });
    await handlePomoJoin(interaction, session, logger);
    expect(ensureConnected).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(deleteReply).not.toHaveBeenCalled();
  });
});

describe('handleAdminRole', () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockResolvedValue({ status: 'ok', config: { ...CONFIG } });
    vi.mocked(saveConfig).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('テキストチャンネルなら VC テキスト欄エラーを出し保存しない', async () => {
    const { interaction, editReply } = makeInteraction(['pomo-admin'], ChannelType.GuildText, {
      subcommand: 'list',
    });
    const { session } = makeSession();
    await handleAdminRole(interaction, session, 'cfg.json', logger);
    expect(editReply).toHaveBeenCalledWith(
      'このコマンドはボイスチャンネル内のテキスト欄で実行してください',
    );
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('権限が無ければ拒否し保存しない', async () => {
    const { interaction, editReply } = makeInteraction(['member'], ChannelType.GuildVoice, {
      subcommand: 'add',
      roleName: 'mod',
    });
    const { session } = makeSession();
    await handleAdminRole(interaction, session, 'cfg.json', logger);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('list: 現在の許可ロールを表示する', async () => {
    const { interaction, editReply } = makeInteraction(['pomo-admin'], ChannelType.GuildVoice, {
      subcommand: 'list',
    });
    const { session } = makeSession();
    await handleAdminRole(interaction, session, 'cfg.json', logger);
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining('pomo-admin'));
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('add: ロールを追加し保存・セッションへ反映する', async () => {
    const { interaction } = makeInteraction(['pomo-admin'], ChannelType.GuildVoice, {
      subcommand: 'add',
      roleName: 'mod',
    });
    const { session } = makeSession();
    await handleAdminRole(interaction, session, 'cfg.json', logger);
    expect(saveConfig).toHaveBeenCalledWith(
      'cfg.json',
      expect.objectContaining({ adminRoleNames: ['mod'] }),
    );
    expect(session.config.adminRoleNames).toEqual(['mod']);
  });

  it('remove: 登録済みロールを外して保存する', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      status: 'ok',
      config: { ...CONFIG, adminRoleNames: ['mod'] },
    });
    const { interaction } = makeInteraction(['pomo-admin'], ChannelType.GuildVoice, {
      subcommand: 'remove',
      roleName: 'mod',
    });
    const { session } = makeSession();
    await handleAdminRole(interaction, session, 'cfg.json', logger);
    expect(saveConfig).toHaveBeenCalledWith(
      'cfg.json',
      expect.objectContaining({ adminRoleNames: [] }),
    );
  });
});
