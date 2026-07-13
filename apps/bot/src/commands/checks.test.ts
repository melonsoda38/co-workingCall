import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  REQUIRED_BOT_PERMISSIONS,
  buildAllowedRoleNames,
  hasAnyAdminRole,
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

describe('buildAllowedRoleNames', () => {
  it('基準ロール + 追加ロールを重複なくまとめる', () => {
    expect(buildAllowedRoleNames('pomo-admin', [])).toEqual(['pomo-admin']);
    expect(buildAllowedRoleNames('pomo-admin', ['mod', '運営'])).toEqual([
      'pomo-admin',
      'mod',
      '運営',
    ]);
    expect(buildAllowedRoleNames('pomo-admin', ['pomo-admin', 'mod'])).toEqual([
      'pomo-admin',
      'mod',
    ]);
  });
});

describe('hasAnyAdminRole', () => {
  it('許可ロールのいずれかを持てば true', () => {
    expect(hasAnyAdminRole(['member', 'mod'], ['pomo-admin', 'mod'])).toBe(true);
    expect(hasAnyAdminRole(['pomo-admin'], ['pomo-admin'])).toBe(true);
    expect(hasAnyAdminRole(['member'], ['pomo-admin', 'mod'])).toBe(false);
    expect(hasAnyAdminRole([], ['pomo-admin'])).toBe(false);
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

  it('AttachFiles は必須で、欠けると検知される (タイマー Embed PNG 添付に必要)', () => {
    expect(REQUIRED_BOT_PERMISSIONS).toContain(PermissionFlagsBits.AttachFiles);
    // AttachFiles 以外を全て持つ状態を作り、AttachFiles だけが欠落として返ることを確認。
    const allButAttach = REQUIRED_BOT_PERMISSIONS.filter(
      (bit) => bit !== PermissionFlagsBits.AttachFiles,
    );
    const perms = new PermissionsBitField(allButAttach);
    expect(missingBotPermissions(perms)).toEqual(['AttachFiles']);
  });
});
