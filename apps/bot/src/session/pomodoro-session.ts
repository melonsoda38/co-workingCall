import type { BotConfig } from '@co-working-call/shared';
import type { Logger } from 'pino';
import type { SoundPlayer } from '../audio/sound-player.js';
import { EmbedManager, type EmbedChannel } from '../embed/embed-manager.js';
import { PomodoroTimer } from '../timer/pomodoro-timer.js';

/**
 * 1 セッション分の結線済みコンポーネント束 (US-15)。
 * timer のフェーズ遷移を EmbedManager が購読し、切替時に SoundPlayer を
 * PhaseSoundNotifier として呼ぶ (work→break=work_end / break→work=break_end /
 * work→finalBreak=final_start)。VC 接続 (soundPlayer.init) と live bot への
 * イベント結線 (▶開始ボタン等) は US-16 で行う。
 */
export interface PomodoroSession {
  timer: PomodoroTimer;
  soundPlayer: SoundPlayer;
  embedManager: EmbedManager;
}

export interface PomodoroSessionDeps {
  channel: EmbedChannel;
  config: BotConfig;
  logger: Logger;
  /** フェーズ切替音を鳴らす SoundPlayer (本番は createDiscordSoundPlayer で生成)。 */
  soundPlayer: SoundPlayer;
}

/**
 * PomodoroTimer + EmbedManager + SoundPlayer を結線してセッションを構築する。
 * EmbedManager のコンストラクタが timer のイベントを購読するため、
 * 戻り値を受け取った時点で結線済み。あとは embedManager.onIdle() で待機 Embed を
 * 出し、timer.start(config.default) でセッションを開始する。
 */
export function createPomodoroSession(deps: PomodoroSessionDeps): PomodoroSession {
  const timer = new PomodoroTimer();
  const embedManager = new EmbedManager({
    channel: deps.channel,
    timer,
    config: deps.config,
    logger: deps.logger,
    soundNotifier: deps.soundPlayer,
  });
  return { timer, soundPlayer: deps.soundPlayer, embedManager };
}
