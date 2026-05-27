import { EmbedBuilder, MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import {
  buildTimerEmbedMessage,
  formatRemaining,
  phaseColor,
  phaseLabel,
  progressBar,
  setProgress,
} from './timer-embed.js';

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
  it('絵文字 + 短いフェーズ名 (セット情報は含まない)', () => {
    expect(phaseLabel(snap({ phase: 'work' }))).toBe('🔥 作業中');
    expect(phaseLabel(snap({ phase: 'break' }))).toBe('☕ 休憩中');
    expect(phaseLabel(snap({ phase: 'finalBreak' }))).toBe('🌙 最終休憩');
    expect(phaseLabel(snap({ phase: 'countdown' }))).toBe('⏰ もうすぐ終了');
    expect(phaseLabel(snap({ phase: 'idle' }))).toBe('🍅 ポモドーロタイマー');
  });
});

describe('setProgress', () => {
  it('work / break は "N/M"、finalBreak / countdown は「最終」、その他は「—」', () => {
    expect(setProgress(snap({ phase: 'work', currentSet: 2, totalSets: 4 }))).toBe('2/4');
    expect(setProgress(snap({ phase: 'break', currentSet: 3, totalSets: 4 }))).toBe('3/4');
    expect(setProgress(snap({ phase: 'finalBreak' }))).toBe('最終');
    expect(setProgress(snap({ phase: 'countdown' }))).toBe('最終');
    expect(setProgress(snap({ phase: 'idle' }))).toBe('—');
    expect(setProgress(snap({ phase: 'ended' }))).toBe('—');
  });
});

describe('phaseColor', () => {
  it('フェーズ別に異なるカラーを返す (左バー視認用)', () => {
    expect(phaseColor('work')).toBe(0xe74c3c);
    expect(phaseColor('break')).toBe(0x2ecc71);
    expect(phaseColor('finalBreak')).toBe(0x3498db);
    expect(phaseColor('countdown')).toBe(0xf1c40f);
    expect(phaseColor('idle')).toBe(0x95a5a6);
    expect(phaseColor('ended')).toBe(0x95a5a6);
  });
});

describe('buildTimerEmbedMessage', () => {
  // zero-width space: Discord field の name 非表示化 / 空行保持に使う。
  // ソース上は \u200B エスケープで書く (no-irregular-whitespace 回避)。
  const ZWSP = '\u200B';

  it('work: title / color / fields 5 段 (残り→フェーズ→セット + bar + 設定サマリ) / フラグ', () => {
    const msg = buildTimerEmbedMessage(
      snap({ phase: 'work', remainingMs: 90_000, currentSet: 2, totalSets: 4 }),
      config,
    );
    const embed = msg.embeds?.[0];
    expect(embed).toBeInstanceOf(EmbedBuilder);
    const json = (embed as EmbedBuilder).toJSON();

    expect(json.title).toBe('🍅 ポモドーロタイマー');
    expect(json.color).toBe(0xe74c3c); // work=赤

    // 残り 90s / 総 1500s → 経過率 (1500-90)/1500 = 0.94 → ▰x9 + ▱x1。
    // フィールド順は「残り → フェーズ → セット」(左から横並び)。
    expect(json.fields).toEqual([
      // 残りは平文 "MM:SS" (Markdown 見出し ## は Embed field 内では非対応のため使わない)。
      { name: '残り', value: '01:30', inline: true },
      { name: 'フェーズ', value: '🔥 作業中', inline: true },
      { name: 'セット', value: '2/4', inline: true },
      // 進捗バーは独立行 (name は ZWSP で非表示)。
      { name: ZWSP, value: '▰▰▰▰▰▰▰▰▰▱', inline: false },
      // 設定サマリ: 進捗バーから 1 行分の空行を挟む。
      {
        name: ZWSP,
        value: `${ZWSP}\n作業25分 / 休憩5分 / 4セット / 最終休憩15分`,
        inline: false,
      },
    ]);

    // description / footer は使わない。
    expect(json.description).toBeUndefined();
    expect(json.footer).toBeUndefined();
    expect(msg.flags).toBe(MessageFlags.SuppressNotifications);
    expect(msg.components ?? []).toHaveLength(0);
  });

  // フィールド順: [0]=残り / [1]=フェーズ / [2]=セット / [3]=進捗バー / [4]=設定サマリ。
  it('break: 緑カラー + セット番号 N/M + 残りは平文 MM:SS', () => {
    const msg = buildTimerEmbedMessage(
      snap({ phase: 'break', remainingMs: 150_000, currentSet: 3, totalSets: 4 }),
      config,
    );
    const json = (msg.embeds?.[0] as EmbedBuilder).toJSON();
    expect(json.color).toBe(0x2ecc71);
    expect(json.fields?.[0]?.value).toBe('02:30');
    expect(json.fields?.[1]?.value).toBe('☕ 休憩中');
    expect(json.fields?.[2]?.value).toBe('3/4');
  });

  it('finalBreak: 青カラー + セット欄は「最終」+ 残りは平文 MM:SS', () => {
    const msg = buildTimerEmbedMessage(snap({ phase: 'finalBreak', remainingMs: 300_000 }), config);
    const json = (msg.embeds?.[0] as EmbedBuilder).toJSON();
    expect(json.color).toBe(0x3498db);
    expect(json.fields?.[0]?.value).toBe('05:00');
    expect(json.fields?.[1]?.value).toBe('🌙 最終休憩');
    expect(json.fields?.[2]?.value).toBe('最終');
  });

  it('countdown: 黄カラー + 残りは ── 固定 + 進捗バー満杯 (4 つ目 field)', () => {
    const msg = buildTimerEmbedMessage(snap({ phase: 'countdown', remainingMs: 5_000 }), config);
    const json = (msg.embeds?.[0] as EmbedBuilder).toJSON();
    expect(json.color).toBe(0xf1c40f);
    expect(json.fields?.[0]?.value).toBe('──');
    expect(json.fields?.[1]?.value).toBe('⏰ もうすぐ終了');
    expect(json.fields?.[2]?.value).toBe('最終');
    // 進捗バーは 4 番目の field (inline: false)。
    expect(json.fields?.[3]?.value).toBe('▰▰▰▰▰▰▰▰▰▰');
    expect(json.fields?.[3]?.inline).toBe(false);
  });

  it('設定サマリ field の値先頭に空行 x1 (ZWSP + 改行) が入る', () => {
    const msg = buildTimerEmbedMessage(snap({ phase: 'work' }), config);
    const json = (msg.embeds?.[0] as EmbedBuilder).toJSON();
    const summaryField = json.fields?.[4];
    expect(summaryField?.value.startsWith(`${ZWSP}\n`)).toBe(true);
    // 2 連続 ZWSP+改行 は入らない (空行は 1 つだけ)。
    expect(summaryField?.value.startsWith(`${ZWSP}\n${ZWSP}\n`)).toBe(false);
    expect(summaryField?.value.endsWith('作業25分 / 休憩5分 / 4セット / 最終休憩15分')).toBe(true);
  });
});
