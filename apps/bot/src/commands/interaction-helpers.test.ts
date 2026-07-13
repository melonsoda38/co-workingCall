import { ChannelType } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  ModalSubmitInteraction,
  RepliableInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import type { VoiceSession } from '../voice/session-registry.js';
import {
  adminRoleRequiredMessage,
  fetchMemberRoleNames,
  GUILD_ONLY_MESSAGE,
  loadOkConfigOrReplySetup,
  replyEphemeral,
  repostStartEmbedBestEffort,
  requireConfigAdminForButton,
  requireVoiceAdminSession,
  respondError,
  SETUP_REQUIRED_INIT,
  SETUP_REQUIRED_RESTART,
  VC_TEXT_ONLY_MESSAGE,
} from './interaction-helpers.js';

vi.mock('../config/index.js', () => ({
  loadVcConfig: vi.fn(),
  DEFAULT_ADMIN_ROLE_NAME: 'pomo-admin',
}));
import { loadVcConfig } from '../config/index.js';

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

afterEach(() => {
  vi.clearAllMocks();
});

function makeConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 },
    guildId: 'guild-1',
    voiceChannelId: 'vc-1',
    adminRoleName: 'pomo-admin',
    adminRoleNames: [],
    volumes: { workEnd: 0, breakEnd: 0, finalStart: 0, countdownWarning: 0, finish: 0 },
    autoStart: { time: null, label: '自動スタート' },
    ...overrides,
  };
}

/** guild.members.fetch がロール名一覧を返すダミー guild。 */
function makeGuild(roleNames: string[]): Guild {
  const fetch = vi.fn(() =>
    Promise.resolve({ roles: { cache: roleNames.map((name) => ({ name })) } }),
  );
  return { id: 'guild-1', members: { fetch } } as unknown as Guild;
}

describe('replyEphemeral', () => {
  it('reply を ephemeral フラグ付きで呼ぶ', async () => {
    const reply = vi.fn<(options: unknown) => Promise<void>>(() => Promise.resolve());
    const interaction = { reply, deferred: false, replied: false } as unknown as RepliableInteraction;
    await replyEphemeral(interaction, 'メッセージ', logger);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[0]).toMatchObject({ content: 'メッセージ' });
  });
});

describe('respondError', () => {
  it('deferReply 済みなら editReply で差し替える', async () => {
    const editReply = vi.fn(() => Promise.resolve());
    const reply = vi.fn(() => Promise.resolve());
    const interaction = { editReply, reply, deferred: true, replied: false } as unknown as RepliableInteraction;
    await respondError(interaction, 'エラー', logger);
    expect(editReply).toHaveBeenCalledWith('エラー');
    expect(reply).not.toHaveBeenCalled();
  });

  it('未応答なら reply(ephemeral) で新規応答する', async () => {
    const editReply = vi.fn(() => Promise.resolve());
    const reply = vi.fn(() => Promise.resolve());
    const interaction = { editReply, reply, deferred: false, replied: false } as unknown as RepliableInteraction;
    await respondError(interaction, 'エラー', logger);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(editReply).not.toHaveBeenCalled();
  });

  it('既に通常応答済み (deferred=false, replied=true) なら二次応答しない', async () => {
    const editReply = vi.fn(() => Promise.resolve());
    const reply = vi.fn(() => Promise.resolve());
    const interaction = { editReply, reply, deferred: false, replied: true } as unknown as RepliableInteraction;
    await respondError(interaction, 'エラー', logger);
    expect(reply).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });

  it('応答自体が失敗しても例外を投げずログのみ', async () => {
    const editReply = vi.fn(() => Promise.reject(new Error('token expired')));
    const interaction = { editReply, deferred: true, replied: false } as unknown as RepliableInteraction;
    await expect(respondError(interaction, 'エラー', logger)).resolves.toBeUndefined();
  });
});

describe('fetchMemberRoleNames', () => {
  it('guild からメンバーの role 名一覧を返す', async () => {
    const guild = makeGuild(['pomo-admin', 'mod']);
    await expect(fetchMemberRoleNames(guild, 'user-1')).resolves.toEqual(['pomo-admin', 'mod']);
  });
});

describe('requireVoiceAdminSession', () => {
  function makeInteraction(roleNames: string[], channelType = ChannelType.GuildVoice) {
    const editReply = vi.fn(() => Promise.resolve());
    const interaction = {
      channel: { type: channelType },
      guild: makeGuild(roleNames),
      user: { id: 'user-1' },
      editReply,
    } as unknown as ChatInputCommandInteraction;
    return { interaction, editReply };
  }

  it('VC テキスト欄以外なら弾く', async () => {
    const { interaction, editReply } = makeInteraction(['pomo-admin'], ChannelType.GuildText);
    const session = { config: makeConfig() } as unknown as VoiceSession;
    expect(await requireVoiceAdminSession({ interaction, session, logger })).toBeNull();
    expect(editReply).toHaveBeenCalledWith(VC_TEXT_ONLY_MESSAGE);
  });

  it('session 未注入なら再起動を促して弾く', async () => {
    const { interaction, editReply } = makeInteraction(['pomo-admin']);
    expect(await requireVoiceAdminSession({ interaction, session: undefined, logger })).toBeNull();
    expect(editReply).toHaveBeenCalledWith(SETUP_REQUIRED_RESTART);
  });

  it('許可ロールを持たなければ弾く', async () => {
    const { interaction, editReply } = makeInteraction(['everyone']);
    const session = { config: makeConfig() } as unknown as VoiceSession;
    expect(await requireVoiceAdminSession({ interaction, session, logger })).toBeNull();
    expect(editReply).toHaveBeenCalledWith(adminRoleRequiredMessage(['pomo-admin']));
  });

  it('許可ロール保持者なら guild/session/allowedRoles を返す', async () => {
    const { interaction, editReply } = makeInteraction(['pomo-admin']);
    const session = { config: makeConfig() } as unknown as VoiceSession;
    const result = await requireVoiceAdminSession({ interaction, session, logger });
    expect(result).not.toBeNull();
    expect(result?.session).toBe(session);
    expect(result?.allowedRoles).toEqual(['pomo-admin']);
    expect(editReply).not.toHaveBeenCalled();
  });
});

describe('requireConfigAdminForButton', () => {
  function makeInteraction(roleNames: string[]) {
    const reply = vi.fn(() => Promise.resolve());
    const interaction = {
      guild: makeGuild(roleNames),
      guildId: 'guild-1',
      channelId: 'vc-1',
      user: { id: 'user-1' },
      reply,
      deferred: false,
      replied: false,
    } as unknown as ButtonInteraction;
    return { interaction, reply };
  }

  it('config が ok なら config を含めて返す', async () => {
    vi.mocked(loadVcConfig).mockResolvedValue({ status: 'ok', config: makeConfig() });
    const { interaction, reply } = makeInteraction(['pomo-admin']);
    const result = await requireConfigAdminForButton({ interaction, configDir: 'cfg', logger });
    expect(result?.config).toEqual(makeConfig());
    expect(reply).not.toHaveBeenCalled();
  });

  it('config 未確定でも pomo-admin ロールなら通す (config=undefined)', async () => {
    vi.mocked(loadVcConfig).mockResolvedValue({ status: 'missing' });
    const { interaction } = makeInteraction(['pomo-admin']);
    const result = await requireConfigAdminForButton({ interaction, configDir: 'cfg', logger });
    expect(result).not.toBeNull();
    expect(result?.config).toBeUndefined();
  });

  it('許可ロールを持たなければ reply して弾く', async () => {
    vi.mocked(loadVcConfig).mockResolvedValue({ status: 'ok', config: makeConfig() });
    const { interaction, reply } = makeInteraction(['everyone']);
    expect(await requireConfigAdminForButton({ interaction, configDir: 'cfg', logger })).toBeNull();
    expect(reply).toHaveBeenCalledTimes(1);
  });
});

describe('loadOkConfigOrReplySetup', () => {
  it('ok なら config を返し reply しない', async () => {
    vi.mocked(loadVcConfig).mockResolvedValue({ status: 'ok', config: makeConfig() });
    const reply = vi.fn(() => Promise.resolve());
    const interaction = {
      reply,
      guildId: 'guild-1',
      channelId: 'vc-1',
    } as unknown as ModalSubmitInteraction;
    await expect(loadOkConfigOrReplySetup(interaction, 'cfg')).resolves.toEqual(makeConfig());
    expect(reply).not.toHaveBeenCalled();
  });

  it('ok でなければ init を促して null を返す', async () => {
    vi.mocked(loadVcConfig).mockResolvedValue({ status: 'missing' });
    const reply = vi.fn<(options: unknown) => Promise<void>>(() => Promise.resolve());
    const interaction = {
      reply,
      guildId: 'guild-1',
      channelId: 'vc-1',
    } as unknown as ModalSubmitInteraction;
    expect(await loadOkConfigOrReplySetup(interaction, 'cfg')).toBeNull();
    expect(reply.mock.calls[0]?.[0]).toMatchObject({ content: SETUP_REQUIRED_INIT });
  });
});

describe('repostStartEmbedBestEffort', () => {
  it('session 未注入なら何もしない', async () => {
    await expect(repostStartEmbedBestEffort(undefined, makeConfig(), logger)).resolves.toBeUndefined();
  });

  it('session があれば repostStartEmbed を呼ぶ', async () => {
    const repostStartEmbed = vi.fn(() => Promise.resolve());
    const session = { embedManager: { repostStartEmbed } } as unknown as VoiceSession;
    await repostStartEmbedBestEffort(session, makeConfig(), logger);
    expect(repostStartEmbed).toHaveBeenCalledTimes(1);
  });

  it('repostStartEmbed が失敗しても例外を投げず warn のみ', async () => {
    const repostStartEmbed = vi.fn(() => Promise.reject(new Error('discord down')));
    const session = { embedManager: { repostStartEmbed } } as unknown as VoiceSession;
    await expect(repostStartEmbedBestEffort(session, makeConfig(), logger)).resolves.toBeUndefined();
  });
});

// GUILD_ONLY_MESSAGE は各ガードで参照される定数。存在を明示的に固定しておく。
describe('共通文言', () => {
  it('GUILD_ONLY_MESSAGE はサーバー内実行を促す文言', () => {
    expect(GUILD_ONLY_MESSAGE).toBe('サーバー内で実行してください');
  });
});
