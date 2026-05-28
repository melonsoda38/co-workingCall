import { EmbedBuilder, MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import { TIMER_IMAGE_NAME, buildTimerEmbedMessage } from './timer-embed.js';

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
  it('work: title / color / 画像添付 / 設定サマリ field / SuppressNotifications', () => {
    const msg = buildTimerEmbedMessage(snap({ phase: 'work', remainingMs: 90_000 }), config);
    const embed = msg.embeds?.[0];
    expect(embed).toBeInstanceOf(EmbedBuilder);
    const json = (embed as EmbedBuilder).toJSON();

    expect(json.title).toBe('🍅 ポモドーロタイマー');
    expect(json.color).toBe(0xe74c3c); // work=赤

    // 円形画像を attachment:// で参照。
    expect(json.image?.url).toBe(`attachment://${TIMER_IMAGE_NAME}`);
    // files に PNG が 1 つ添付される。
    expect(msg.files).toHaveLength(1);

    // text field は設定サマリのみ (フェーズ/セット/残りは画像に集約)。
    expect(json.fields).toHaveLength(1);
    expect(json.fields?.[0]?.value).toBe('作業25分 / 休憩5分 / 4セット / 最終休憩15分');

    expect(msg.flags).toBe(MessageFlags.SuppressNotifications);
    expect(msg.components ?? []).toHaveLength(0);
  });

  it('break / finalBreak / countdown で左バー色が変わる', () => {
    const color = (s: TimerSnapshot): number | undefined =>
      (buildTimerEmbedMessage(s, config).embeds?.[0] as EmbedBuilder).toJSON().color;
    expect(color(snap({ phase: 'break' }))).toBe(0x2ecc71);
    expect(color(snap({ phase: 'finalBreak' }))).toBe(0x3498db);
    expect(color(snap({ phase: 'countdown' }))).toBe(0xf1c40f);
  });
});
