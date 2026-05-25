import { joinVoiceChannel } from '@discordjs/voice';
import { ChannelType, Events, type Client, type VoiceChannel, type VoiceState } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import { createDiscordSoundPlayer } from '../audio/index.js';
import { createDiscordEmbedChannel } from '../discord/discord-embed-channel.js';
import { createPomodoroSession } from '../session/index.js';
import type { VoiceSessionRegistry } from './session-registry.js';
import { VoiceManager, isTargetVcEvent, type VoiceConnectionHandle } from './voice-manager.js';

/** VC の人間 (非 bot) メンバー数を数える (voice-spec)。 */
export function countHumans(channel: VoiceChannel): number {
  return channel.members.filter((member) => !member.user.bot).size;
}

/** 対象 VC へ接続する。失敗時は null (リトライしない: voice-spec)。 */
function connectToVc(channel: VoiceChannel, logger: Logger): VoiceConnectionHandle | null {
  try {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    // VoiceConnection の 'error' は未処理だと例外で落ちうる。必ず捕捉してログに残す。
    connection.on('error', (err) => {
      logger.error({ err: err.message }, 'VoiceConnection エラー');
    });
    return connection;
  } catch (err) {
    logger.error({ err }, 'joinVoiceChannel に失敗しました');
    return null;
  }
}

/** voiceStateUpdate を VoiceManager に橋渡しする (bot 自身・無関係 VC は無視)。 */
function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  channel: VoiceChannel,
  targetVcId: string,
  voiceManager: VoiceManager,
): void {
  // bot 自身・他 bot のイベントは無視する (voice-spec)。
  if (newState.member?.user.bot ?? false) {
    return;
  }
  if (
    !isTargetVcEvent({
      oldChannelId: oldState.channelId,
      newChannelId: newState.channelId,
      targetVcId,
    })
  ) {
    return;
  }
  void voiceManager.handleHumanCountChange(countHumans(channel));
}

/**
 * config 有効時に VC 自動入退室機能を結線する (US-16)。
 * 対象 VC を解決し、SoundPlayer・セッション・VoiceManager を構築して
 * voiceStateUpdate を購読する。構築したセッションは registry に登録し、
 * ▶開始ボタン等の interaction ハンドラから参照できるようにする。
 */
export async function setupVoiceFeature(
  client: Client<true>,
  config: BotConfig,
  logger: Logger,
  sessions: VoiceSessionRegistry,
): Promise<void> {
  const channel = await client.channels.fetch(config.voiceChannelId);
  if (channel?.type !== ChannelType.GuildVoice) {
    logger.warn(
      { voiceChannelId: config.voiceChannelId },
      '対象 VC が見つからないため VC機能を無効化',
    );
    return;
  }

  const soundPlayer = createDiscordSoundPlayer(logger);
  const session = createPomodoroSession({
    channel: createDiscordEmbedChannel(channel),
    config,
    logger,
    soundPlayer,
  });
  const voiceManager = new VoiceManager({
    logger,
    soundPlayer,
    timer: session.timer,
    connect: () => Promise.resolve(connectToVc(channel, logger)),
    resetToIdle: () => session.embedManager.onIdle(),
  });

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleVoiceStateUpdate(oldState, newState, channel, config.voiceChannelId, voiceManager);
  });

  // ▶開始ボタン等から参照できるよう、ギルド単位でセッションを登録する。
  sessions.set(config.guildId, {
    config,
    timer: session.timer,
    embedManager: session.embedManager,
    voiceManager,
  });

  // 起動時点の人間数を反映 (既に人がいれば入室する)。
  void voiceManager.handleHumanCountChange(countHumans(channel));
  logger.info({ voiceChannelId: channel.id }, 'VC 自動入退室機能を有効化しました');
}
