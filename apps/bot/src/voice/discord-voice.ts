import { joinVoiceChannel } from '@discordjs/voice';
import { ChannelType, Events, type Client, type VoiceChannel, type VoiceState } from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import { createDiscordSoundPlayer } from '../audio/index.js';
import { AutoStartScheduler } from '../auto-start/scheduler.js';
import { runAutoStart } from '../auto-start/run-auto-start.js';
import { createDiscordEmbedChannel } from '../discord/discord-embed-channel.js';
import type { EndingActions } from '../embed/index.js';
import { createPomodoroSession } from '../session/index.js';
import type { VoiceSession, VoiceSessionRegistry } from './session-registry.js';
import {
  VoiceManager,
  isJoinToTargetVc,
  isTargetVcEvent,
  type VoiceConnectionHandle,
} from './voice-manager.js';

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

/**
 * VC 内の人間メンバーを切断する (ending-spec §強制退出の実装)。
 * except に含まれる ID は残す (「続行」を押したユーザの残留に使う。US-続行)。
 * 順次 await + best-effort (個別失敗は warn ログのみ)。bot 自身は最後に
 * VoiceManager.forceDisconnect で切る (本関数では触らない)。
 */
async function kickHumansFromVc(
  channel: VoiceChannel,
  logger: Logger,
  except?: ReadonlySet<string>,
): Promise<void> {
  for (const [, member] of channel.members) {
    if (member.user.bot) {
      continue;
    }
    if (except?.has(member.id)) {
      continue;
    }
    try {
      await member.voice.disconnect();
    } catch (err) {
      logger.warn({ err, userId: member.id }, 'メンバーの強制退出に失敗 (best-effort)');
    }
  }
}

/** 入室挨拶の投稿窓口 (EmbedManager を最小構造で受ける)。 */
interface JoinGreeter {
  postJoinGreeting(displayName: string): Promise<void>;
}

/** voiceStateUpdate を VoiceManager に橋渡しする (bot 自身・無関係 VC は無視)。 */
function handleVoiceStateUpdate(
  oldState: VoiceState,
  newState: VoiceState,
  channel: VoiceChannel,
  targetVcId: string,
  voiceManager: VoiceManager,
  greeter: JoinGreeter,
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
  // 対象 VC への新規入室なら挨拶を投稿する (best-effort)。表示名が取れない場合は投稿しない。
  if (
    isJoinToTargetVc({
      oldChannelId: oldState.channelId,
      newChannelId: newState.channelId,
      targetVcId,
    })
  ) {
    const displayName = newState.member?.displayName;
    if (displayName) {
      void greeter.postJoinGreeting(displayName);
    }
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
  configDir: string,
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
  // 起動時点の音量設定 (config.volumes) を反映する。以降は ▶開始のたびに最新値へ更新される。
  soundPlayer.setVolumes(config.volumes);
  // VoiceManager と EmbedManager は相互参照する (endingActions.disconnectBot →
  // voiceManager.forceDisconnect)。順序解決のため ref オブジェクトで遅延参照する。
  // 実行時 (onEnded 発火時) には voiceManagerRef.current が代入済みで安全。
  const voiceManagerRef: { current: VoiceManager | null } = { current: null };
  const endingActions: EndingActions = {
    kickAllHumans: () => kickHumansFromVc(channel, logger),
    kickHumansExcept: (except) => kickHumansFromVc(channel, logger, except),
    disconnectBot: () => {
      voiceManagerRef.current?.forceDisconnect();
    },
  };
  const session = createPomodoroSession({
    channel: createDiscordEmbedChannel(channel, logger),
    config,
    logger,
    soundPlayer,
    endingActions,
  });
  const voiceManager = new VoiceManager({
    logger,
    soundPlayer,
    timer: session.timer,
    connect: () => Promise.resolve(connectToVc(channel, logger)),
    resetToIdle: () => session.embedManager.onIdle(),
    // US-20: 空 VC 30 秒 + タイマー実行中の経路。timer を先に止めてから US-19 の
    // 終了演出フロー (EmbedManager.onEnded) を直接駆動する。
    triggerEndingFlow: async () => {
      session.timer.stop();
      await session.embedManager.onEnded();
    },
  });
  voiceManagerRef.current = voiceManager;

  // 設定サイクルが完了 (timer 'ended') した時点で自動スタート由来の抑止を解除する。
  // これにより「続行」で継続ループへ移行した場合は、以降は手動セッションと同じ空 VC 退出挙動に戻る。
  // (EmbedManager も同 'ended' を購読しており多重リスナは問題ない。)
  session.timer.on('ended', () => {
    voiceManager.clearAutoStartedSession();
  });

  // 起動時クリーンアップ: 再起動で id 追跡を失った孤児のお疲れさま等テキストを掃除する
  // (例: ended 直後30秒以内の再起動で残るお疲れさま投稿)。アクティブセッションは無い。
  await session.embedManager.purgeOrphanTexts();

  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleVoiceStateUpdate(
      oldState,
      newState,
      channel,
      config.voiceChannelId,
      voiceManager,
      session.embedManager,
    );
  });

  // 自動スタートスケジューラ。onFire は登録する voiceSession を遅延参照する
  // (発火時にはセッション構築済み)。起動時に config.autoStart.time で武装する。
  const autoStartScheduler = new AutoStartScheduler({
    logger,
    onFire: () => runAutoStart(voiceSession, configDir, logger),
  });

  // ▶開始ボタン等から参照できるよう、VC 単位でセッションを登録する
  // (キーは voiceChannelId。VC のテキストチャットで発生する interaction/message は channelId で解決)。
  const voiceSession: VoiceSession = {
    config,
    timer: session.timer,
    embedManager: session.embedManager,
    voiceManager,
    soundPlayer,
    autoStartScheduler,
  };
  sessions.set(config.voiceChannelId, voiceSession);
  autoStartScheduler.schedule(config.autoStart.time);

  // 起動時点の人間数を反映 (既に人がいれば入室する)。
  void voiceManager.handleHumanCountChange(countHumans(channel));
  logger.info({ voiceChannelId: channel.id }, 'VC 自動入退室機能を有効化しました');
}
