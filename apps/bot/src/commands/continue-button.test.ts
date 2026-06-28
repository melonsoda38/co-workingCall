import { describe, expect, it, vi } from 'vitest';
import { GuildMember, type ButtonInteraction } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import type { VoiceSession } from '../voice/session-registry.js';
import { handleContinueButton } from './continue-button.js';

const logger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const TARGET_VC = 'vc-1';

function makeInteraction(memberVcId: string | null) {
  const reply = vi.fn<(options: { content?: string }) => Promise<void>>(() => Promise.resolve());
  const fetch = vi.fn(() => Promise.resolve({ id: 'user-1', voice: { channelId: memberVcId } }));
  const interaction = {
    user: { id: 'user-1' },
    guildId: 'guild-1',
    guild: { id: 'guild-1', members: { fetch } },
    replied: false,
    deferred: false,
    reply,
  } as unknown as ButtonInteraction;
  return { interaction, reply };
}

/**
 * interaction.member がキャッシュ済み GuildMember として渡るケース (US-続行 レース対策の層C)。
 * fetch を呼ばず同期で VC 判定・登録できることを検証するため、GuildMember.prototype を継いだ
 * オブジェクトで instanceof GuildMember を満たしつつ voice.channelId を持たせる。
 */
function makeInteractionWithCachedMember(memberVcId: string | null) {
  const reply = vi.fn<(options: { content?: string }) => Promise<void>>(() => Promise.resolve());
  const fetch = vi.fn(() => Promise.resolve({ id: 'user-1', voice: { channelId: memberVcId } }));
  // GuildMember.prototype は id/voice を getter で持つため Object.assign では上書きできない。
  // 自前のデータプロパティで getter をシャドウし、instanceof GuildMember を満たしたまま値を持たせる。
  const member = Object.defineProperties(Object.create(GuildMember.prototype) as GuildMember, {
    id: { value: 'user-1', enumerable: true },
    voice: { value: { channelId: memberVcId }, enumerable: true },
  });
  const interaction = {
    user: { id: 'user-1' },
    guildId: 'guild-1',
    guild: { id: 'guild-1', members: { fetch } },
    member,
    replied: false,
    deferred: false,
    reply,
  } as unknown as ButtonInteraction;
  return { interaction, reply, fetch };
}

function makeSession(registerResult: 'ok' | 'closed') {
  const registerContinueUser = vi.fn(() => registerResult);
  const config: BotConfig = {
    default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 },
    guildId: 'guild-1',
    voiceChannelId: TARGET_VC,
    adminRoleName: 'pomo-admin',
    adminRoleNames: [],
    volumes: { workEnd: 0, breakEnd: 0, finalStart: 0, countdownWarning: 0, finish: 0 },
  };
  const session = {
    config,
    embedManager: { registerContinueUser },
  } as unknown as VoiceSession;
  return { session, registerContinueUser };
}

describe('handleContinueButton', () => {
  it('session が無ければ ephemeral 応答する', async () => {
    const { interaction, reply } = makeInteraction(TARGET_VC);
    await handleContinueButton(interaction, undefined, logger);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('対象 VC にいなければ ephemeral 応答し受付しない', async () => {
    const { interaction, reply } = makeInteraction('other-vc');
    const { session, registerContinueUser } = makeSession('ok');
    await handleContinueButton(interaction, session, logger);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(registerContinueUser).not.toHaveBeenCalled();
  });

  it('受理時 (ok) は registerContinueUser を呼び受付完了を返す', async () => {
    const { interaction, reply } = makeInteraction(TARGET_VC);
    const { session, registerContinueUser } = makeSession('ok');
    await handleContinueButton(interaction, session, logger);
    expect(registerContinueUser).toHaveBeenCalledWith('user-1');
    const content = vi.mocked(reply).mock.calls[0]?.[0];
    expect(JSON.stringify(content)).toContain('続行を受け付けました');
  });

  it('受付終了 (closed) は受付終了メッセージを返す', async () => {
    const { interaction, reply } = makeInteraction(TARGET_VC);
    const { session, registerContinueUser } = makeSession('closed');
    await handleContinueButton(interaction, session, logger);
    expect(registerContinueUser).toHaveBeenCalledWith('user-1');
    const content = vi.mocked(reply).mock.calls[0]?.[0];
    expect(JSON.stringify(content)).toContain('続行の受付は終了しました');
  });

  it('member がキャッシュ済みなら fetch せず同期で判定・登録する (層C)', async () => {
    const { interaction, fetch } = makeInteractionWithCachedMember(TARGET_VC);
    const { session, registerContinueUser } = makeSession('ok');
    await handleContinueButton(interaction, session, logger);
    expect(fetch).not.toHaveBeenCalled();
    expect(registerContinueUser).toHaveBeenCalledWith('user-1');
  });

  it('member が無ければ fetch にフォールバックする', async () => {
    const { interaction } = makeInteraction(TARGET_VC);
    const fetch = (interaction.guild as unknown as { members: { fetch: ReturnType<typeof vi.fn> } })
      .members.fetch;
    const { session, registerContinueUser } = makeSession('ok');
    await handleContinueButton(interaction, session, logger);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(registerContinueUser).toHaveBeenCalledWith('user-1');
  });

  it('キャッシュ済み member が対象 VC にいなければ受付しない', async () => {
    const { interaction, reply, fetch } = makeInteractionWithCachedMember('other-vc');
    const { session, registerContinueUser } = makeSession('ok');
    await handleContinueButton(interaction, session, logger);
    expect(fetch).not.toHaveBeenCalled();
    expect(registerContinueUser).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
