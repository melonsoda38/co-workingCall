import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelType, type ChatInputCommandInteraction } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import type { VoiceSession } from '../voice/session-registry.js';
import { PermissionFlagsBits } from 'discord.js';
import {
  handleAdminRole,
  handleAutoLabel,
  handlePomoInit,
  handlePomoStop,
  pomoCommand,
} from './pomo.js';

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
  volumes: { workEnd: 0, breakEnd: 0, finalStart: 0, countdownWarning: 0, finish: 0 },
  autoStart: { time: null, label: '自動スタート' },
};

function makeInteraction(
  roleNames: string[],
  channelType: ChannelType = ChannelType.GuildVoice,
  options?: { subcommand?: string; roleName?: string; text?: string },
) {
  const deferReply = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const editReply = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const deleteReply = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const fetch = vi.fn(() =>
    Promise.resolve({ roles: { cache: roleNames.map((name) => ({ name })) } }),
  );
  const getSubcommand = vi.fn(() => options?.subcommand ?? 'list');
  const getRole = vi.fn(() => ({ name: options?.roleName ?? 'mod' }));
  const getString = vi.fn(() => options?.text ?? '朝活');
  const interaction = {
    user: { id: 'user-1' },
    guildId: 'guild-1',
    guild: { id: 'guild-1', members: { fetch } },
    channel: { type: channelType },
    options: { getSubcommand, getRole, getString },
    deferred: true,
    replied: false,
    deferReply,
    editReply,
    deleteReply,
  } as unknown as ChatInputCommandInteraction;
  return {
    interaction,
    deferReply,
    editReply,
    deleteReply,
    fetch,
    getSubcommand,
    getRole,
    getString,
  };
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

describe('pomoCommand', () => {
  it('コマンド一覧の可視性を「サーバー管理」権限保有者に限定している', () => {
    const json = pomoCommand.toJSON();
    expect(json.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
  });
});

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

  it('remove: 基準ロールも追加ロールが残るなら外せ、残りの先頭を基準に繰り上げる', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      status: 'ok',
      config: { ...CONFIG, adminRoleNames: ['study-lead'] },
    });
    const { interaction } = makeInteraction(['pomo-admin'], ChannelType.GuildVoice, {
      subcommand: 'remove',
      roleName: 'pomo-admin',
    });
    const { session } = makeSession();
    await handleAdminRole(interaction, session, 'cfg.json', logger);
    expect(saveConfig).toHaveBeenCalledWith(
      'cfg.json',
      expect.objectContaining({ adminRoleName: 'study-lead', adminRoleNames: [] }),
    );
    expect(session.config.adminRoleName).toBe('study-lead');
  });

  it('remove: 許可ロールが 1 つだけのときは外せず保存しない', async () => {
    vi.mocked(loadConfig).mockResolvedValue({ status: 'ok', config: { ...CONFIG } });
    const { interaction, editReply } = makeInteraction(['pomo-admin'], ChannelType.GuildVoice, {
      subcommand: 'remove',
      roleName: 'pomo-admin',
    });
    const { session } = makeSession();
    await handleAdminRole(interaction, session, 'cfg.json', logger);
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining('唯一の許可ロール'));
    expect(saveConfig).not.toHaveBeenCalled();
  });
});

describe('handleAutoLabel', () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockResolvedValue({ status: 'ok', config: { ...CONFIG } });
    vi.mocked(saveConfig).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('テキストチャンネルなら VC テキスト欄エラーを出し保存しない', async () => {
    const { interaction, editReply } = makeInteraction(['pomo-admin'], ChannelType.GuildText, {
      text: '朝活',
    });
    const { session } = makeSession();
    await handleAutoLabel(interaction, session, 'cfg.json', logger);
    expect(editReply).toHaveBeenCalledWith(
      'このコマンドはボイスチャンネル内のテキスト欄で実行してください',
    );
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('権限が無ければ拒否し保存しない', async () => {
    const { interaction } = makeInteraction(['member'], ChannelType.GuildVoice, { text: '朝活' });
    const { session } = makeSession();
    await handleAutoLabel(interaction, session, 'cfg.json', logger);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('ラベルを保存しセッションへ反映する (時刻は変えない)', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      status: 'ok',
      config: { ...CONFIG, autoStart: { time: '07:30', label: '自動スタート' } },
    });
    const { interaction, editReply } = makeInteraction(['pomo-admin'], ChannelType.GuildVoice, {
      text: '朝活',
    });
    const { session } = makeSession();
    await handleAutoLabel(interaction, session, 'cfg.json', logger);
    expect(saveConfig).toHaveBeenCalledWith(
      'cfg.json',
      expect.objectContaining({ autoStart: { time: '07:30', label: '朝活' } }),
    );
    expect(session.config.autoStart.label).toBe('朝活');
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining('朝活'));
  });
});

describe('handlePomoInit: Start Embed を EmbedManager に取り込む (設定モーダル再投稿の前提)', () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockResolvedValue({ status: 'ok', config: { ...CONFIG } });
    vi.mocked(saveConfig).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('channel.send で投稿した Start Embed の id を session.embedManager.adoptStartEmbed に渡す', async () => {
    // handlePomoInit は permissionsFor / channel.send / channel.messages.fetch などを
    // 直接触るため、それらを満たす最小モック VoiceChannel を構築する。
    const send = vi.fn(() => Promise.resolve({ id: 'start-embed-msg-id' }));
    const channelMessages = {
      fetch: vi.fn(() =>
        // purgeOwnEmbeds が読む形: filter().values()
        Promise.resolve({ filter: () => ({ values: () => [].values() }) }),
      ),
    };
    const fakeMe = { id: 'bot-1' };
    const channel = {
      id: 'vc-1',
      type: ChannelType.GuildVoice,
      send,
      messages: channelMessages,
      permissionsFor: vi.fn(() => ({
        has: () => true,
        missing: () => [],
      })),
      client: { user: { id: 'bot-1' } },
    };

    const memberFetch = vi.fn(() =>
      Promise.resolve({ roles: { cache: [{ name: 'pomo-admin' }] } }),
    );
    const deferReply = vi.fn(() => Promise.resolve());
    const editReply = vi.fn(() => Promise.resolve());
    const interaction = {
      user: { id: 'user-1' },
      guildId: 'guild-1',
      guild: { id: 'guild-1', members: { fetch: memberFetch, me: fakeMe } },
      channel,
      options: { getSubcommand: () => 'init', getSubcommandGroup: () => null },
      deferred: false,
      replied: false,
      deferReply,
      editReply,
      client: { user: { id: 'bot-1' } },
    } as unknown as ChatInputCommandInteraction;

    const adoptStartEmbed = vi.fn();
    const ensureConnected = vi.fn(() => Promise.resolve(true));
    const session = {
      config: CONFIG,
      embedManager: { adoptStartEmbed },
      voiceManager: { ensureConnected, connected: false },
    } as unknown as VoiceSession;

    await handlePomoInit(interaction, session, 'cfg.json', logger);

    expect(send).toHaveBeenCalledTimes(1);
    expect(adoptStartEmbed).toHaveBeenCalledWith('start-embed-msg-id');
    // 後続処理 (VC 接続) も通常通り実行される。
    expect(ensureConnected).toHaveBeenCalledTimes(1);
  });

  it('session 未注入 (READY 前) でも channel.send 自体は完遂し adoptStartEmbed は呼ばれない', async () => {
    const send = vi.fn(() => Promise.resolve({ id: 'start-embed-msg-id' }));
    const channel = {
      id: 'vc-1',
      type: ChannelType.GuildVoice,
      send,
      messages: {
        fetch: vi.fn(() => Promise.resolve({ filter: () => ({ values: () => [].values() }) })),
      },
      permissionsFor: vi.fn(() => ({ has: () => true, missing: () => [] })),
      client: { user: { id: 'bot-1' } },
    };
    const memberFetch = vi.fn(() =>
      Promise.resolve({ roles: { cache: [{ name: 'pomo-admin' }] } }),
    );
    const interaction = {
      user: { id: 'user-1' },
      guildId: 'guild-1',
      guild: { id: 'guild-1', members: { fetch: memberFetch, me: { id: 'bot-1' } } },
      channel,
      options: { getSubcommand: () => 'init', getSubcommandGroup: () => null },
      deferred: false,
      replied: false,
      deferReply: vi.fn(() => Promise.resolve()),
      editReply: vi.fn(() => Promise.resolve()),
      client: { user: { id: 'bot-1' } },
    } as unknown as ChatInputCommandInteraction;

    // session=undefined でも throw せず完了する (adoptStartEmbed は呼ばれない)。
    await expect(
      handlePomoInit(interaction, undefined, 'cfg.json', logger),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
