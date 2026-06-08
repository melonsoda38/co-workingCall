import { ActionRowBuilder, ButtonBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import { CONTINUE_BUTTON_ID, TIMER_IMAGE_NAME, buildTimerEmbedMessage } from './timer-embed.js';

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

describe('buildTimerEmbedMessage', () => {
  it('work: title / color / 画像添付 / 設定サマリ footer / SuppressNotifications', () => {
    const msg = buildTimerEmbedMessage(snap({ phase: 'work', remainingMs: 90_000 }), config);
    const embed = msg.embeds?.[0];
    expect(embed).toBeInstanceOf(EmbedBuilder);
    const json = (embed as EmbedBuilder).toJSON();

    expect(json.title).toBe('Timer');
    expect(json.color).toBe(0x3498db); // work=青

    // 円形画像を attachment:// で参照。
    expect(json.image?.url).toBe(`attachment://${TIMER_IMAGE_NAME}`);
    // files に PNG が 1 つ添付される。
    expect(msg.files).toHaveLength(1);

    // 設定サマリは画像の下 (footer) に出す。title 直下の余白用 field は持たない。
    expect(json.fields ?? []).toHaveLength(0);
    expect(json.footer?.text).toBe('作業25分 / 休憩5分 / 4セット / 最終休憩15分');

    expect(msg.flags).toBe(MessageFlags.SuppressNotifications);
    expect(msg.components ?? []).toHaveLength(0);
    // 作業中は続行案内テキストを出さない。
    expect(msg.content ?? '').toBe('');
  });

  it('break / finalBreak / countdown で左バー色が変わる', () => {
    const color = (s: TimerSnapshot): number | undefined =>
      (buildTimerEmbedMessage(s, config).embeds?.[0] as EmbedBuilder).toJSON().color;
    expect(color(snap({ phase: 'break' }))).toBe(0x2ecc71);
    expect(color(snap({ phase: 'finalBreak' }))).toBe(0x95a5a6);
    expect(color(snap({ phase: 'countdown' }))).toBe(0xf1c40f);
  });

  it('finalBreak: 画像の外 (content) に太字の続行案内、Embed 下に続行ボタンを付ける', () => {
    const msg = buildTimerEmbedMessage(snap({ phase: 'finalBreak' }), config);
    const json = (msg.embeds?.[0] as EmbedBuilder).toJSON();
    // 続行案内は footer (画像下) ではなく content (画像の外) に太字で出す。
    expect(json.footer?.text).toBe('作業25分 / 休憩5分 / 4セット / 最終休憩15分');
    expect(msg.content).toBe('**続ける場合:**');

    expect(msg.components).toHaveLength(1);
    const row = (msg.components?.[0] as ActionRowBuilder<ButtonBuilder>).toJSON();
    expect(row.components).toHaveLength(1);
    const button = row.components[0] as { custom_id?: string; label?: string };
    expect(button.custom_id).toBe(CONTINUE_BUTTON_ID);
    expect(button.label).toBe('続行');
  });

  it('work/break/countdown には続行ボタンも続行案内テキストも付かない', () => {
    for (const phase of ['work', 'break', 'countdown'] as const) {
      const msg = buildTimerEmbedMessage(snap({ phase }), config);
      const json = (msg.embeds?.[0] as EmbedBuilder).toJSON();
      expect(json.footer?.text).toBe('作業25分 / 休憩5分 / 4セット / 最終休憩15分');
      expect(msg.components ?? []).toHaveLength(0);
      expect(msg.content ?? '').toBe('');
    }
  });
});
