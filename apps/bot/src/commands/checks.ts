import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';

/** /pomo init を実行できるのは VC 内蔵テキスト欄のみ (commands-spec.md)。 */
export function isVoiceTextContext(channelType: ChannelType | undefined): boolean {
  return channelType === ChannelType.GuildVoice;
}

/** 実行者が adminRoleName ロールを持つか。 */
export function hasAdminRole(memberRoleNames: readonly string[], adminRoleName: string): boolean {
  return memberRoleNames.includes(adminRoleName);
}

/** bot に必要な VC 権限 (CLAUDE.me セキュリティ節)。 */
export const REQUIRED_BOT_PERMISSIONS: readonly bigint[] = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.EmbedLinks,
];

/** 与えられた権限に対し、必要権限のうち欠けているフラグ名一覧を返す。 */
export function missingBotPermissions(
  permissions: Readonly<PermissionsBitField>,
  required: readonly bigint[] = REQUIRED_BOT_PERMISSIONS,
): string[] {
  return required
    .filter((bit) => !permissions.has(bit))
    .map((bit) => new PermissionsBitField(bit).toArray()[0] ?? String(bit));
}
