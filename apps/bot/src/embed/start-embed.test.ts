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
  VOLUME_BUTTON_ID,
  buildStartEmbedMessage,
  formatConfigSummary,
} from './start-embed.js';

const config: BotConfig = {
  default: { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 900 },
  guildId: 'g',
  voiceChannelId: 'v',
  adminRoleName: 'pomo-admin',
  adminRoleNames: [],
  volumes: { workEnd: 0, breakEnd: 0, finalStart: 0, countdownWarning: 0, finish: 0 },
  autoStart: { time: null, label: '自動スタート' },
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

  it('自動スタート時刻が未設定 (null) なら自動スタートのフィールドを出さない', () => {
    const msg = buildStartEmbedMessage(config);
    const json = (msg.embeds?.[0] as EmbedBuilder).toJSON();
    expect(json.fields).toHaveLength(1);
    expect(json.fields?.some((f) => f.name === '自動スタート')).toBe(false);
  });

  it('自動スタート時刻が設定済みなら案内フィールドを出す', () => {
    const withAutoStart: BotConfig = {
      ...config,
      autoStart: { time: '07:00', label: '自動スタート' },
    };
    const msg = buildStartEmbedMessage(withAutoStart);
    const json = (msg.embeds?.[0] as EmbedBuilder).toJSON();
    expect(json.fields?.[1]).toMatchObject({
      name: '自動スタート',
      value: '07:00にタイマーが自動スタートします',
    });
  });

  it('SuppressNotifications フラグが付く', () => {
    const msg = buildStartEmbedMessage(config);
    expect(msg.flags).toBe(MessageFlags.SuppressNotifications);
  });

  it('開始/設定/音量ボタンの custom_id・style', () => {
    const msg = buildStartEmbedMessage(config);
    const row = msg.components?.[0];
    expect(row).toBeInstanceOf(ActionRowBuilder);
    const json = (row as ActionRowBuilder<ButtonBuilder>).toJSON();
    expect(json.components).toHaveLength(3);
    expect(json.components[0]).toMatchObject({
      custom_id: START_BUTTON_ID,
      style: ButtonStyle.Primary,
    });
    expect(json.components[1]).toMatchObject({
      custom_id: SETTINGS_BUTTON_ID,
      style: ButtonStyle.Secondary,
      label: '⚙️: ⏰',
    });
    expect(json.components[2]).toMatchObject({
      custom_id: VOLUME_BUTTON_ID,
      style: ButtonStyle.Secondary,
      label: '⚙️: 🔊',
    });
  });
});
