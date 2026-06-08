import { describe, expect, it } from 'vitest';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import {
  centerText,
  phaseColorHex,
  phaseTextPlain,
  progressRatio,
  renderTimerImage,
  setText,
} from './timer-image.js';

const config: BotConfig = {
  default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 },
  guildId: 'g',
  voiceChannelId: 'v',
  adminRoleName: 'pomo-admin',
  adminRoleNames: [],
};

const snap = (over: Partial<TimerSnapshot>): TimerSnapshot => ({
  phase: 'work',
  remainingMs: 600_000,
  currentSet: 1,
  totalSets: 4,
  startedAt: 0,
  ...over,
});

describe('phaseColorHex', () => {
  it('フェーズ別の 16進カラー', () => {
    expect(phaseColorHex('work')).toBe('#3498db');
    expect(phaseColorHex('break')).toBe('#2ecc71');
    expect(phaseColorHex('finalBreak')).toBe('#95a5a6');
    expect(phaseColorHex('countdown')).toBe('#f1c40f');
    expect(phaseColorHex('idle')).toBe('#95a5a6');
    expect(phaseColorHex('ended')).toBe('#95a5a6');
  });
});

describe('progressRatio', () => {
  it('work: 経過割合 (clamp)', () => {
    // 残り 1500s / 総 1500s → 経過 0。
    expect(progressRatio(snap({ phase: 'work', remainingMs: 1_500_000 }), config)).toBeCloseTo(0);
    // 残り 750s → 経過 0.5。
    expect(progressRatio(snap({ phase: 'work', remainingMs: 750_000 }), config)).toBeCloseTo(0.5);
    // 残り 0 → 経過 1。
    expect(progressRatio(snap({ phase: 'work', remainingMs: 0 }), config)).toBeCloseTo(1);
  });

  it('countdown は常に満杯 (1)', () => {
    expect(progressRatio(snap({ phase: 'countdown', remainingMs: 5_000 }), config)).toBe(1);
  });

  it('idle / ended は 0 (総時間 0)', () => {
    expect(progressRatio(snap({ phase: 'idle' }), config)).toBe(0);
    expect(progressRatio(snap({ phase: 'ended' }), config)).toBe(0);
  });
});

describe('centerText (分刻み)', () => {
  it('work/break/finalBreak は残り分を切り上げ', () => {
    expect(centerText(snap({ phase: 'work', remainingMs: 1_500_000 }))).toEqual({
      main: '25',
      unit: '分',
    });
    // 残り 90 秒 → ceil(1.5) = 2 分。
    expect(centerText(snap({ phase: 'work', remainingMs: 90_000 }))).toEqual({
      main: '2',
      unit: '分',
    });
    // 残り 60 秒 → 1 分。
    expect(centerText(snap({ phase: 'break', remainingMs: 60_000 }))).toEqual({
      main: '1',
      unit: '分',
    });
  });

  it('countdown は「まもなく / 終了」の 2 行 (改行入り)', () => {
    expect(centerText(snap({ phase: 'countdown', remainingMs: 5_000 }))).toEqual({
      main: 'まもなく\n終了',
      unit: '',
    });
  });
});

describe('phaseTextPlain', () => {
  it('絵文字なしのフェーズ名 (canvas はカラー絵文字を描けない)', () => {
    expect(phaseTextPlain(snap({ phase: 'work' }))).toBe('作業中');
    expect(phaseTextPlain(snap({ phase: 'break' }))).toBe('休憩中');
    expect(phaseTextPlain(snap({ phase: 'finalBreak' }))).toBe('最終休憩');
    // countdown は中央の「まもなく」だけ。下段は空。
    expect(phaseTextPlain(snap({ phase: 'countdown' }))).toBe('');
    expect(phaseTextPlain(snap({ phase: 'idle' }))).toBe('');
  });
});

describe('setText', () => {
  it('work/break は N/M、finalBreak・countdown・その他は空', () => {
    expect(setText(snap({ phase: 'work', currentSet: 2, totalSets: 4 }))).toBe('2/4');
    expect(setText(snap({ phase: 'break', currentSet: 3, totalSets: 4 }))).toBe('3/4');
    expect(setText(snap({ phase: 'finalBreak' }))).toBe('');
    expect(setText(snap({ phase: 'countdown' }))).toBe('');
    expect(setText(snap({ phase: 'idle' }))).toBe('');
  });

  it('継続モード (continuous) は work/break で「N回目」を表示する', () => {
    expect(setText(snap({ phase: 'work', currentSet: 3, totalSets: 0, continuous: true }))).toBe(
      '3回目',
    );
    expect(setText(snap({ phase: 'break', currentSet: 1, totalSets: 0, continuous: true }))).toBe(
      '1回目',
    );
  });
});

describe('renderTimerImage', () => {
  // PNG マジックナンバー (先頭 8 バイト): 89 50 4E 47 0D 0A 1A 0A。
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('各フェーズで例外なく PNG Buffer を返す', () => {
    for (const phase of ['work', 'break', 'finalBreak', 'countdown'] as const) {
      const png = renderTimerImage(snap({ phase, remainingMs: 300_000 }), config);
      expect(Buffer.isBuffer(png)).toBe(true);
      expect(png.length).toBeGreaterThan(0);
      // PNG ヘッダで始まる。
      expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    }
  });
});
