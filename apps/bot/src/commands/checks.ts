import { ChannelType, PermissionFlagsBits, PermissionsBitField } from 'discord.js';

/** /pomo init を実行できるのは VC 内蔵テキスト欄のみ (commands-spec.md)。 */
export function isVoiceTextContext(channelType: ChannelType | undefined): boolean {
  return channelType === ChannelType.GuildVoice;
}

/** config から許可ロール名一覧を作る (基準ロール + 追加ロール、重複除去)。 */
export function buildAllowedRoleNames(
  adminRoleName: string,
  adminRoleNames: readonly string[],
): string[] {
  return [...new Set([adminRoleName, ...adminRoleNames])];
}

/** 実行者が許可ロール一覧のいずれかを持つか。 */
export function hasAnyAdminRole(
  memberRoleNames: readonly string[],
  allowedRoleNames: readonly string[],
): boolean {
  return memberRoleNames.some((name) => allowedRoleNames.includes(name));
}

/**
 * ▶開始 / 設定ボタン操作の権限不足時に表示する共通エラー文言。
 * /pomo コマンドと同じ許可ロール集合 (buildAllowedRoleNames) を使う前提。
 */
export function buttonRoleRequiredMessage(allowedRoleNames: readonly string[]): string {
  return `この操作には ${allowedRoleNames.join(' / ')} のいずれかのロールが必要です`;
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
