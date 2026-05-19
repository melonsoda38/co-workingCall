import type { TimerPhase } from '@co-working-call/shared';

/**
 * フェーズ切替系の通知音 (audio-spec SoundPlayer 指針のサブセット)。
 * 実装 (実 @discordjs/voice 再生) は US-15 の SoundPlayer。US-11 は注入のみ。
 */
export interface PhaseSoundNotifier {
  playWorkEnd(): void;
  playBreakEnd(): void;
  playFinalStart(): void;
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
