import type { TimerPhase } from '@co-working-call/shared';

/**
 * フェーズ切替系 + 終了予告の通知音 (audio-spec SoundPlayer 指針のサブセット)。
 * 実装 (実 @discordjs/voice 再生) は US-15 の SoundPlayer。
 * - playWorkEnd / playBreakEnd / playFinalStart … フェーズ切替 (US-11)
 * - playCountdownWarning … 終了予告 (US-18、countdown 突入時に 1 回)
 * 終了音 (finish.mp3) は US-19 で別途扱う。
 */
export interface PhaseSoundNotifier {
  playWorkEnd(): void;
  playBreakEnd(): void;
  playFinalStart(): void;
  playCountdownWarning(): void;
}

export type PhaseTransitionSound = 'workEnd' | 'breakEnd' | 'finalStart' | null;

/**
 * フェーズ遷移 (from→to) に対応する通知音種別を返す純粋関数。
 * work→break=work_end / break→work=break_end / work→finalBreak=final_start。
 * それ以外 (初回・countdown 等) は null。
 */
export function phaseTransitionSound(from: TimerPhase, to: TimerPhase): PhaseTransitionSound {
  if (from === 'work' && to === 'break') {
    return 'workEnd';
  }
  if (from === 'break' && to === 'work') {
    return 'breakEnd';
  }
  if (from === 'work' && to === 'finalBreak') {
    return 'finalStart';
  }
  return null;
}

/** sound 種別に応じて notifier の対応メソッドを呼ぶ。 */
export function playPhaseTransitionSound(
  notifier: PhaseSoundNotifier,
  sound: PhaseTransitionSound,
): void {
  switch (sound) {
    case 'workEnd':
      notifier.playWorkEnd();
      break;
    case 'breakEnd':
      notifier.playBreakEnd();
      break;
    case 'finalStart':
      notifier.playFinalStart();
      break;
    case null:
      break;
  }
}
