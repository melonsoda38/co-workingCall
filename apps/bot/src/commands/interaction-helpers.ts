import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Guild,
  MessageFlags,
  ModalSubmitInteraction,
  type RepliableInteraction,
} from 'discord.js';
import type { Logger } from 'pino';
import type { BotConfig } from '@co-working-call/shared';
import { DEFAULT_ADMIN_ROLE_NAME, loadConfig } from '../config/index.js';
import type { VoiceSession } from '../voice/session-registry.js';
import {
  buildAllowedRoleNames,
  buttonRoleRequiredMessage,
  hasAnyAdminRole,
  isVoiceTextContext,
} from './checks.js';
import { scheduleEphemeralAutoDelete } from './ephemeral.js';

/** VC 内蔵テキスト欄以外で /pomo 系コマンドを実行したときの共通エラー文言。 */
export const VC_TEXT_ONLY_MESSAGE =
  'このコマンドはボイスチャンネル内のテキスト欄で実行してください';

/** サーバー(ギルド)外で実行したときの共通エラー文言。 */
export const GUILD_ONLY_MESSAGE = 'サーバー内で実行してください';

/** session 未注入 (READY 前 / config 未確定) 時の共通エラー文言 (再起動を促す)。 */
export const SETUP_REQUIRED_RESTART =
  'セットアップが必要です。/pomo init 実行後に bot を再起動してください';

/** config 未確定でモーダル送信されたときの共通エラー文言 (先に init を促す)。 */
export const SETUP_REQUIRED_INIT = 'セットアップが必要です。先に /pomo init を実行してください';

/** 権限不足時の /pomo 系コマンド用エラー文言 (許可ロールを列挙)。 */
export function adminRoleRequiredMessage(allowedRoleNames: readonly string[]): string {
  return `このコマンドの実行には ${allowedRoleNames.join(' / ')} のいずれかのロールが必要です`;
}

/**
 * ephemeral 応答を送り、自動削除をスケジュールする共通ヘルパー (ボタン系の早期 return 用)。
 * deferReply しないボタン/モーダルの成功前 return とエラー応答で使う。
 */
export async function replyEphemeral(
  interaction: RepliableInteraction,
  content: string,
  logger: Logger,
): Promise<void> {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  scheduleEphemeralAutoDelete(interaction, logger);
}

/**
 * catch 内の二次エラー応答。呼び出し元の deferred/replied 状態に応じて応答手段を選ぶ:
 * - deferReply 済み (pomo 系 / defer するハンドラ) → editReply で差し替える。
 * - 未応答 (モーダル送信など) → reply(ephemeral) で新規応答する。
 * - 既に通常応答済み (deferred=false, replied=true) → 二次応答しない (元のモーダル挙動を踏襲)。
 * 応答自体が失敗しても例外は伝播させずログのみ。自動削除は呼び出し元の finally / 応答手段側に委ねる。
 */
export async function respondError(
  interaction: RepliableInteraction,
  message: string,
  logger: Logger,
): Promise<void> {
  try {
    if (interaction.deferred) {
      await interaction.editReply(message);
    } else if (!interaction.replied) {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  } catch (replyErr) {
    logger.error({ err: replyErr }, 'エラー応答にも失敗しました');
  }
}

/** guild からメンバーを fetch してロール名一覧を返す。 */
export async function fetchMemberRoleNames(guild: Guild, userId: string): Promise<string[]> {
  const member = await guild.members.fetch(userId);
  return member.roles.cache.map((role) => role.name);
}

/**
 * /pomo stop / admin-role / auto-label の共通前置き (defer 済み前提)。
 * VC-text チェック → session 必須 → guild → 許可ロール判定を行い、通れば guild と許可ロール集合を返す。
 * いずれかで弾く場合は既存文言で editReply して null を返す (呼び出し元は null なら early return)。
 * 許可ロールは session.config を基準にする。
 */
export async function requireVoiceAdminSession(params: {
  interaction: ChatInputCommandInteraction;
  session: VoiceSession | undefined;
  logger: Logger;
}): Promise<{ guild: Guild; session: VoiceSession; allowedRoles: string[] } | null> {
  const { interaction, session } = params;
  if (!isVoiceTextContext(interaction.channel?.type)) {
    await interaction.editReply(VC_TEXT_ONLY_MESSAGE);
    return null;
  }
  if (!session) {
    await interaction.editReply(SETUP_REQUIRED_RESTART);
    return null;
  }
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply(GUILD_ONLY_MESSAGE);
    return null;
  }
  const roleNames = await fetchMemberRoleNames(guild, interaction.user.id);
  const allowedRoles = buildAllowedRoleNames(
    session.config.adminRoleName,
    session.config.adminRoleNames,
  );
  if (!hasAnyAdminRole(roleNames, allowedRoles)) {
    await interaction.editReply(adminRoleRequiredMessage(allowedRoles));
    return null;
  }
  return { guild, session, allowedRoles };
}

/**
 * 設定 / 音量ボタン押下時の共通認可 (defer しないボタン前提)。
 * guild → loadConfig ベースの許可ロール判定を行い、通れば guild・config・許可ロール集合を返す。
 * 弾く場合は replyEphemeral (自動削除付き) して null を返す。config 未確定時は基準ロール
 * 'pomo-admin' にフォールバックする (config は ok のときのみ値、それ以外は undefined)。
 */
export async function requireConfigAdminForButton(params: {
  interaction: ButtonInteraction;
  configPath: string;
  logger: Logger;
}): Promise<{ guild: Guild; config: BotConfig | undefined; allowedRoles: string[] } | null> {
  const { interaction, configPath, logger } = params;
  const guild = interaction.guild;
  if (!guild) {
    await replyEphemeral(interaction, GUILD_ONLY_MESSAGE, logger);
    return null;
  }
  const existing = await loadConfig(configPath);
  const config = existing.status === 'ok' ? existing.config : undefined;
  const allowedRoles = buildAllowedRoleNames(
    config?.adminRoleName ?? DEFAULT_ADMIN_ROLE_NAME,
    config?.adminRoleNames ?? [],
  );
  const roleNames = await fetchMemberRoleNames(guild, interaction.user.id);
  if (!hasAnyAdminRole(roleNames, allowedRoles)) {
    await replyEphemeral(interaction, buttonRoleRequiredMessage(allowedRoles), logger);
    return null;
  }
  return { guild, config, allowedRoles };
}

/**
 * モーダル送信で config を読み、ok でなければセットアップ必要を reply して null を返す。
 * ok なら BotConfig を返す (呼び出し元は null なら early return)。
 */
export async function loadOkConfigOrReplySetup(
  interaction: ModalSubmitInteraction,
  configPath: string,
): Promise<BotConfig | null> {
  const existing = await loadConfig(configPath);
  if (existing.status !== 'ok') {
    await interaction.reply({ content: SETUP_REQUIRED_INIT, flags: MessageFlags.Ephemeral });
    return null;
  }
  return existing.config;
}

/**
 * 最新 config で Start Embed を投稿し直す (モーダル送信の best-effort フォローアップ)。
 * session 未注入ならスキップ。失敗は warn ログのみで握りつぶす (config 保存は完了扱いのため)。
 */
export async function repostStartEmbedBestEffort(
  session: VoiceSession | undefined,
  updated: BotConfig,
  logger: Logger,
): Promise<void> {
  if (!session) {
    return;
  }
  try {
    await session.embedManager.repostStartEmbed(updated);
  } catch (repostErr) {
    logger.warn({ err: repostErr }, 'Start Embed の投稿し直しに失敗 (best-effort、config 保存は完了)');
  }
}
