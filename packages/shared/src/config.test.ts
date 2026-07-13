import { describe, it, expect } from 'vitest';
import {
  BotConfigSchema,
  GuildConfigFileSchema,
  toBotConfigs,
  upsertVc,
  type BotConfig,
  type GuildConfigFile,
} from './config.js';

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

describe('GuildConfigFileSchema / toBotConfigs / upsertVc', () => {
  const validDefault = { workSec: 1500, breakSec: 300, sets: 4, finalBreakSec: 600 };
  const makeBotConfig = (voiceChannelId: string, guildId = 'g1'): BotConfig => ({
    default: validDefault,
    guildId,
    voiceChannelId,
    adminRoleName: 'pomo-admin',
    adminRoleNames: [],
    volumes: { workEnd: 0, breakEnd: 0, finalStart: 0, countdownWarning: 0, finish: 0 },
    autoStart: { time: null, label: '自動スタート' },
  });

  it('vcs が空配列なら拒否する (最低1件)', () => {
    expect(
      GuildConfigFileSchema.safeParse({ guildId: 'g1', vcs: [] }).success,
    ).toBe(false);
  });

  it('adminRole 系省略時は既定値で埋まる', () => {
    const file = GuildConfigFileSchema.parse({
      guildId: 'g1',
      vcs: [{ voiceChannelId: 'vc1', default: validDefault }],
    });
    expect(file.adminRoleName).toBe('pomo-admin');
    expect(file.adminRoleNames).toEqual([]);
    // Vc の volumes / autoStart も後方互換で既定補完される
    expect(file.vcs[0]?.volumes).toEqual({
      workEnd: 0,
      breakEnd: 0,
      finalStart: 0,
      countdownWarning: 0,
      finish: 0,
    });
    expect(file.vcs[0]?.autoStart).toEqual({ time: null, label: '自動スタート' });
  });

  it('toBotConfigs は VC ごとに guild レベル項目を差し込んで展開する', () => {
    const file: GuildConfigFile = {
      guildId: 'g1',
      adminRoleName: 'mods',
      adminRoleNames: ['staff'],
      vcs: [
        {
          voiceChannelId: 'vc1',
          default: validDefault,
          volumes: { workEnd: 1, breakEnd: 0, finalStart: 0, countdownWarning: 0, finish: 0 },
          autoStart: { time: '07:30', label: '朝活' },
        },
        {
          voiceChannelId: 'vc2',
          default: validDefault,
          volumes: { workEnd: 0, breakEnd: 0, finalStart: 0, countdownWarning: 0, finish: 0 },
          autoStart: { time: null, label: '自動スタート' },
        },
      ],
    };
    const configs = toBotConfigs(file);
    expect(configs).toHaveLength(2);
    expect(configs[0]).toMatchObject({
      guildId: 'g1',
      voiceChannelId: 'vc1',
      adminRoleName: 'mods',
      adminRoleNames: ['staff'],
      autoStart: { time: '07:30', label: '朝活' },
    });
    expect(configs[1]?.voiceChannelId).toBe('vc2');
  });

  it('upsertVc: base=null で当該 VC のみの新規ファイルを生成する', () => {
    const file = upsertVc(null, makeBotConfig('vc1'));
    expect(file.guildId).toBe('g1');
    expect(file.vcs).toHaveLength(1);
    expect(file.vcs[0]?.voiceChannelId).toBe('vc1');
  });

  it('upsertVc: 同一 guild の別 VC を追加すると同居する (同一ファイル)', () => {
    const first = upsertVc(null, makeBotConfig('vc1'));
    const merged = upsertVc(first, makeBotConfig('vc2'));
    expect(merged.vcs.map((v) => v.voiceChannelId)).toEqual(['vc1', 'vc2']);
  });

  it('upsertVc: 既存 VC は差し替えられ重複しない・guild レベル項目も更新される', () => {
    const first = upsertVc(null, makeBotConfig('vc1'));
    const updated: BotConfig = {
      ...makeBotConfig('vc1'),
      adminRoleName: 'newadmin',
      default: { ...validDefault, sets: 8 },
    };
    const merged = upsertVc(first, updated);
    expect(merged.vcs).toHaveLength(1);
    expect(merged.vcs[0]?.default.sets).toBe(8);
    expect(merged.adminRoleName).toBe('newadmin');
  });

  it('toBotConfigs と upsertVc は往復で一致する (VC単位)', () => {
    const config = makeBotConfig('vc1');
    const file = upsertVc(null, config);
    expect(toBotConfigs(file)[0]).toEqual(config);
  });
});
