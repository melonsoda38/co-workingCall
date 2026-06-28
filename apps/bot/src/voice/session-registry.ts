import type { BotConfig } from '@co-working-call/shared';
import type { SoundPlayer } from '../audio/sound-player.js';
import type { EmbedManager } from '../embed/embed-manager.js';
import type { PomodoroTimer } from '../timer/pomodoro-timer.js';
import type { VoiceManager } from './voice-manager.js';

/**
 * 1 ギルド分の結線済みセッション。setupVoiceFeature (READY 時) が生成して
 * レジストリに登録し、▶開始ボタン等の interaction ハンドラから参照する。
 */
export interface VoiceSession {
  config: BotConfig;
  timer: PomodoroTimer;
  embedManager: EmbedManager;
  voiceManager: VoiceManager;
  /** 通知音プレイヤー。音量設定の反映 (setVolumes) をセッション開始時に行う。 */
  soundPlayer: SoundPlayer;
}

/** guildId をキーにしたセッションの登録簿。 */
export type VoiceSessionRegistry = Map<string, VoiceSession>;

/** 空のセッションレジストリを生成する。 */
export function createVoiceSessionRegistry(): VoiceSessionRegistry {
  return new Map<string, VoiceSession>();
}
