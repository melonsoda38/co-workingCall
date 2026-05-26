import { describe, expect, it, vi } from 'vitest';
import {
  phaseTransitionSound,
  playPhaseTransitionSound,
  type PhaseSoundNotifier,
} from './sound-notifier.js';

describe('phaseTransitionSound', () => {
  it('対象3遷移に対応する音種別を返す', () => {
    expect(phaseTransitionSound('work', 'break')).toBe('workEnd');
    expect(phaseTransitionSound('break', 'work')).toBe('breakEnd');
    expect(phaseTransitionSound('work', 'finalBreak')).toBe('finalStart');
  });

  it('対象外の遷移は null', () => {
    expect(phaseTransitionSound('idle', 'work')).toBeNull();
    expect(phaseTransitionSound('finalBreak', 'countdown')).toBeNull();
    expect(phaseTransitionSound('work', 'work')).toBeNull();
  });
});

describe('playPhaseTransitionSound', () => {
  it('種別に対応するメソッドのみ呼ぶ', () => {
    const playWorkEnd = vi.fn();
    const playBreakEnd = vi.fn();
    const playFinalStart = vi.fn();
    const playCountdownWarning = vi.fn();
    const playFinish = vi.fn();
    const notifier: PhaseSoundNotifier = {
      playWorkEnd,
      playBreakEnd,
      playFinalStart,
      playCountdownWarning,
      playFinish,
    };

    playPhaseTransitionSound(notifier, 'workEnd');
    expect(playWorkEnd).toHaveBeenCalledTimes(1);

    playPhaseTransitionSound(notifier, 'finalStart');
    expect(playFinalStart).toHaveBeenCalledTimes(1);

    playPhaseTransitionSound(notifier, null);
    expect(playBreakEnd).not.toHaveBeenCalled();
  });
});
