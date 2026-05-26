import { EmbedBuilder, MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import { buildTimerEmbedMessage, formatRemaining, phaseLabel, progressBar } from './timer-embed.js';

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

describe('formatRemaining', () => {
  it('MM:SS、負値は 00:00', () => {
    expect(formatRemaining(90_000)).toBe('01:30');
    expect(formatRemaining(0)).toBe('00:00');
    expect(formatRemaining(-5)).toBe('00:00');
    expect(formatRemaining(3_661_000)).toBe('61:01');
  });
});

describe('progressBar', () => {
  it('比率を ▰▱ 10分割で表現 (clamp)', () => {
    expect(progressBar(0)).toBe('▱▱▱▱▱▱▱▱▱▱');
    expect(progressBar(1)).toBe('▰▰▰▰▰▰▰▰▰▰');
    expect(progressBar(0.5)).toBe('▰▰▰▰▰▱▱▱▱▱');
    expect(progressBar(2)).toBe('▰▰▰▰▰▰▰▰▰▰');
    expect(progressBar(-1)).toBe('▱▱▱▱▱▱▱▱▱▱');
  });
});

describe('phaseLabel', () => {
  it('embed-spec §2 のフェーズ表示', () => {
    expect(phaseLabel(snap({ phase: 'work', currentSet: 2, totalSets: 4 }))).toBe(
      '🔥 作業中 (2/4)',
    );
    expect(phaseLabel(snap({ phase: 'break', currentSet: 1, totalSets: 4 }))).toBe(
      '☕ 休憩中 (1/4)',
    );
    expect(phaseLabel(snap({ phase: 'finalBreak' }))).toBe('🌙 最終休憩');
    expect(phaseLabel(snap({ phase: 'countdown' }))).toBe('⏰ もうすぐ終了');
  });
});

describe('buildTimerEmbedMessage', () => {
  it('work: タイトル/フェーズ/残り/フッター/フラグ、ボタンは無し', () => {
    const msg = buildTimerEmbedMessage(snap({ phase: 'work', remainingMs: 90_000 }), config);
    const embed = msg.embeds?.[0];
    expect(embed).toBeInstanceOf(EmbedBuilder);
    const json = (embed as EmbedBuilder).toJSON();
    expect(json.title).toBe('🍅 ポモドーロタイマー');
    expect(json.description).toContain('🔥 作業中 (1/4)');
    expect(json.description).toContain('残り 01:30');
    expect(json.footer?.text).toBe('作業25分 / 休憩5分 / 4セット / 最終休憩15分');
    expect(msg.flags).toBe(MessageFlags.SuppressNotifications);

    // 設定アイコン (無効化ボタン) は廃止: components は持たない。
    expect(msg.components ?? []).toHaveLength(0);
  });

  it('countdown: 残りは ── 固定でバー満杯', () => {
    const msg = buildTimerEmbedMessage(snap({ phase: 'countdown', remainingMs: 5_000 }), config);
    const json = (msg.embeds?.[0] as EmbedBuilder).toJSON();
    expect(json.description).toContain('⏰ もうすぐ終了');
    expect(json.description).toContain('残り ──');
    expect(json.description).toContain('▰▰▰▰▰▰▰▰▰▰');
  });
});
