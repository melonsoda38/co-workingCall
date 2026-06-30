import { describe, it, expect } from 'vitest';
import { BotConfigSchema } from './config.js';

describe('BotConfigSchema', () => {
  const validDefault = { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 600 };

  it('有効な設定を受理する', () => {
    const parsed = BotConfigSchema.parse({
      default: validDefault,
      guildId: '123',
      voiceChannelId: '456',
      adminRoleName: 'mods',
    });
    expect(parsed.adminRoleName).toBe('mods');
  });

  it('adminRoleName 省略時は既定値 pomo-admin になる', () => {
    const parsed = BotConfigSchema.parse({
      default: validDefault,
      guildId: '123',
      voiceChannelId: '456',
    });
    expect(parsed.adminRoleName).toBe('pomo-admin');
  });

  it('guildId が空文字なら拒否する', () => {
    expect(
      BotConfigSchema.safeParse({
        default: validDefault,
        guildId: '',
        voiceChannelId: '456',
      }).success,
    ).toBe(false);
  });

  it('default が不正な TimerConfig なら拒否する', () => {
    expect(
      BotConfigSchema.safeParse({
        default: { ...validDefault, sets: 0 },
        guildId: '123',
        voiceChannelId: '456',
      }).success,
    ).toBe(false);
  });

  it('autoStart 省略時は無効 (time=null・既定ラベル) で埋まる (後方互換)', () => {
    const parsed = BotConfigSchema.parse({
      default: validDefault,
      guildId: '123',
      voiceChannelId: '456',
    });
    expect(parsed.autoStart).toEqual({ time: null, label: '自動スタート' });
  });

  it('autoStart の time は HH:MM 形式のみ受理する', () => {
    expect(
      BotConfigSchema.safeParse({
        default: validDefault,
        guildId: '123',
        voiceChannelId: '456',
        autoStart: { time: '07:30', label: '朝活' },
      }).success,
    ).toBe(true);
    expect(
      BotConfigSchema.safeParse({
        default: validDefault,
        guildId: '123',
        voiceChannelId: '456',
        autoStart: { time: '7:30' },
      }).success,
    ).toBe(false);
  });
});
