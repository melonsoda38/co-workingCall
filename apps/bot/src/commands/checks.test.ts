import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_BOT_PERMISSIONS,
  hasAdminRole,
  isVoiceTextContext,
  missingBotPermissions,
} from './checks.js';

describe('isVoiceTextContext', () => {
  it('VC (GuildVoice) のテキスト欄のみ true', () => {
    expect(isVoiceTextContext(ChannelType.GuildVoice)).toBe(true);
    expect(isVoiceTextContext(ChannelType.GuildText)).toBe(false);
    expect(isVoiceTextContext(undefined)).toBe(false);
  });
});

describe('hasAdminRole', () => {
  it('adminRoleName を含めば true', () => {
    expect(hasAdminRole(['pomo-admin', 'member'], 'pomo-admin')).toBe(true);
    expect(hasAdminRole(['member'], 'pomo-admin')).toBe(false);
    expect(hasAdminRole([], 'pomo-admin')).toBe(false);
  });
});

describe('missingBotPermissions', () => {
  it('全権限ありなら欠落なし', () => {
    const perms = new PermissionsBitField(REQUIRED_BOT_PERMISSIONS);
    expect(missingBotPermissions(perms)).toEqual([]);
  });

  it('一部のみだと欠落を返す', () => {
    const perms = new PermissionsBitField([PermissionFlagsBits.ViewChannel]);
    const missing = missingBotPermissions(perms);
    expect(missing.length).toBe(REQUIRED_BOT_PERMISSIONS.length - 1);
    expect(missing).toContain('Connect');
    expect(missing).not.toContain('ViewChannel');
  });

  it('権限ゼロなら全権限が欠落', () => {
    const perms = new PermissionsBitField();
    expect(missingBotPermissions(perms).length).toBe(REQUIRED_BOT_PERMISSIONS.length);
  });
});
