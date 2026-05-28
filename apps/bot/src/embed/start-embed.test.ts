import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { BotConfig } from '@co-working-call/shared';
import {
  SETTINGS_BUTTON_ID,
  START_BUTTON_ID,
  buildStartEmbedMessage,
  formatConfigSummary,
} from './start-embed.js';

const config: BotConfig = {
  default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 },
  guildId: 'g',
  voiceChannelId: 'v',
  adminRoleName: 'pomo-admin',
  adminRoleNames: [],
};

describe('formatConfigSummary', () => {
  it('embed-spec の1行表記になる', () => {
    expect(formatConfigSummary(config)).toBe('作業25分 / 休憩5分 / 4セット / 最終休憩15分');
  });
});

describe('buildStartEmbedMessage', () => {
  it('タイトル・説明・設定が embed-spec §1 準拠', () => {
    const msg = buildStartEmbedMessage(config);
    const embed = msg.embeds?.[0];
    expect(embed).toBeInstanceOf(EmbedBuilder);
    const json = (embed as EmbedBuilder).toJSON();
    expect(json.title).toBe('Timer');
    expect(json.description).toBe('ボタンを押して作業を始めましょう');
    expect(json.fields?.[0]).toMatchObject({
      name: '現在の設定',
      value: '作業25分 / 休憩5分 / 4セット / 最終休憩15分',
    });
  });

  it('SuppressNotifications フラグが付く', () => {
    const msg = buildStartEmbedMessage(config);
    expect(msg.flags).toBe(MessageFlags.SuppressNotifications);
  });

  it('開始/設定ボタンの custom_id・style', () => {
    const msg = buildStartEmbedMessage(config);
    const row = msg.components?.[0];
    expect(row).toBeInstanceOf(ActionRowBuilder);
    const json = (row as ActionRowBuilder<ButtonBuilder>).toJSON();
    expect(json.components).toHaveLength(2);
    expect(json.components[0]).toMatchObject({
      custom_id: START_BUTTON_ID,
      style: ButtonStyle.Primary,
    });
    expect(json.components[1]).toMatchObject({
      custom_id: SETTINGS_BUTTON_ID,
      style: ButtonStyle.Secondary,
    });
  });
});
