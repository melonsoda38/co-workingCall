import { ContainerBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { BotConfig, TimerSnapshot } from '@co-working-call/shared';
import {
  CONTINUE_BUTTON_ID,
  CONTINUE_PROMPT_TEXT,
  TIMER_IMAGE_NAME,
  buildTimerEmbedMessage,
} from './timer-embed.js';

const config: BotConfig = {
  default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 },
  guildId: 'g',
  voiceChannelId: 'v',
  adminRoleName: 'pomo-admin',
  adminRoleNames: [],
};

const SUMMARY = '作業25分 / 休憩5分 / 4セット / 最終休憩15分';

const snap = (over: Partial<TimerSnapshot>): TimerSnapshot => ({
  phase: 'work',
  remainingMs: 600_000,
  currentSet: 1,
  totalSets: 4,
  startedAt: 0,
  ...over,
});

/** Components V2 Container を toJSON して中身を取り出すヘルパ。 */
interface V2Component {
  type: number;
  content?: string;
  items?: { media: { url: string } }[];
  components?: { custom_id?: string; label?: string }[];
}
function containerOf(msg: ReturnType<typeof buildTimerEmbedMessage>): {
  accentColor: number | null | undefined;
  texts: string[];
  imageUrl: string | undefined;
  buttons: { custom_id?: string; label?: string }[];
} {
  const json = (msg.components?.[0] as ContainerBuilder).toJSON();
  const comps = json.components as unknown as V2Component[];
  const texts = comps.filter((c) => c.type === 10).map((c) => c.content ?? '');
  const gallery = comps.find((c) => c.type === 12);
  const row = comps.find((c) => c.type === 1);
  return {
    accentColor: json.accent_color,
    texts,
    imageUrl: gallery?.items?.[0]?.media.url,
    buttons: row?.components ?? [],
  };
}

describe('buildTimerEmbedMessage', () => {
  it('work: Embed (title / color / 画像 / 設定サマリ footer / SuppressNotifications・V2でない)', () => {
    const msg = buildTimerEmbedMessage(snap({ phase: 'work', remainingMs: 90_000 }), config);
    const embed = msg.embeds?.[0];
    expect(embed).toBeInstanceOf(EmbedBuilder);
    const json = (embed as EmbedBuilder).toJSON();

    expect(json.title).toBe('Timer');
    expect(json.color).toBe(0x3498db); // work=青
    expect(json.image?.url).toBe(`attachment://${TIMER_IMAGE_NAME}`);
    expect(msg.files).toHaveLength(1);
    expect(json.fields ?? []).toHaveLength(0);
    expect(json.footer?.text).toBe(SUMMARY);

    expect(msg.flags).toBe(MessageFlags.SuppressNotifications);
    expect(msg.components ?? []).toHaveLength(0);
  });

  it('break も Embed (緑バー)', () => {
    const msg = buildTimerEmbedMessage(snap({ phase: 'break' }), config);
    expect((msg.embeds?.[0] as EmbedBuilder).toJSON().color).toBe(0x2ecc71);
    expect(msg.components ?? []).toHaveLength(0);
  });

  it('finalBreak: Components V2 で画像の下に太字の続行案内と続行ボタン', () => {
    const msg = buildTimerEmbedMessage(snap({ phase: 'finalBreak' }), config);
    // V2 メッセージは Embed を持たず、IsComponentsV2 + SuppressNotifications フラグが立つ。
    expect(msg.embeds ?? []).toHaveLength(0);
    expect(Number(msg.flags) & MessageFlags.IsComponentsV2).toBeTruthy();
    expect(Number(msg.flags) & MessageFlags.SuppressNotifications).toBeTruthy();

    const { accentColor, texts, imageUrl, buttons } = containerOf(msg);
    expect(accentColor).toBe(0x95a5a6); // finalBreak=グレー
    expect(imageUrl).toBe(`attachment://${TIMER_IMAGE_NAME}`);
    // タイトル・設定サマリ (subtext)・太字の続行案内が、画像の下にこの順で並ぶ。
    expect(texts).toEqual(['**Timer**', `-# ${SUMMARY}`, `**${CONTINUE_PROMPT_TEXT}**`]);
    // 続行案内 (太字) は画像 (gallery, index 1) より後・ボタンより前。
    const imageIdx = (msg.components?.[0] as ContainerBuilder)
      .toJSON()
      .components.findIndex((c) => (c as { type: number }).type === 12);
    const promptIdx = (msg.components?.[0] as ContainerBuilder)
      .toJSON()
      .components.findIndex(
        (c) => (c as { content?: string }).content === `**${CONTINUE_PROMPT_TEXT}**`,
      );
    expect(promptIdx).toBeGreaterThan(imageIdx);

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.custom_id).toBe(CONTINUE_BUTTON_ID);
    expect(buttons[0]?.label).toBe('続行');
  });

  it('countdown: Components V2 だが続行案内/ボタンは付かない (黄バー)', () => {
    const msg = buildTimerEmbedMessage(snap({ phase: 'countdown' }), config);
    expect(msg.embeds ?? []).toHaveLength(0);
    expect(Number(msg.flags) & MessageFlags.IsComponentsV2).toBeTruthy();

    const { accentColor, texts, imageUrl, buttons } = containerOf(msg);
    expect(accentColor).toBe(0xf1c40f); // countdown=黄
    expect(imageUrl).toBe(`attachment://${TIMER_IMAGE_NAME}`);
    expect(texts).toEqual(['**Timer**', `-# ${SUMMARY}`]);
    expect(texts).not.toContain(`**${CONTINUE_PROMPT_TEXT}**`);
    expect(buttons).toHaveLength(0);
  });
});
